import { createHash, randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { platform, arch } from "node:os"
import { spawn } from "node:child_process"
import * as tar from "tar"

const ASSETS = {
  "win32-x64": ["15.0.19", "windows-x86_64", "6ac067402c7b4a3dc37887ed3754b3914b67fdc220c966190683e9ccf91abf0f"],
  "linux-x64": ["15.0.19", "linux-x86_64", "5a8f19f5f119b5fa2a8fd799a3a532e3236ad36164241800d6302e32f0e1c2a9"],
  // Stable 15.0.19 did not publish Linux arm64; use the official alpha expert
  // bundle only for that missing platform.
  "linux-arm64": ["16.0a9", "linux-aarch64", "8f68bcd64e59f993ee463ec2b758c0ccd9d0f9679d5fa086f8d48ab3653d2d3f"],
  "darwin-x64": ["15.0.19", "macos-x86_64", "95243f76bcf05d6179d017c3f3e4ece7b53cc58dff1ba617b03a2fe2c8298b5b"],
  "darwin-arm64": ["15.0.19", "macos-aarch64", "c99cf6f69740a443c7fffaf598ceb0952b3914041507c8afe11bed84a3333eb1"],
}

async function exists(file) { try { await fs.access(file); return true } catch { return false } }

async function sha256(file) {
  const hash = createHash("sha256")
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
  return hash.digest("hex")
}

async function findExecutable(root) {
  const wanted = platform() === "win32" ? "tor.exe" : "tor"
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await visit(full)
        if (nested) return nested
      } else if (entry.name.toLowerCase() === wanted) return full
    }
  }
  return visit(root)
}

export async function ensureTorBinary(runtimeRoot, override = "") {
  if (override && await exists(override)) return resolve(override)
  const key = `${platform()}-${arch()}`
  const asset = ASSETS[key]
  if (!asset) throw new Error(`Automatic Tor provisioning does not support ${key}. Set OPENCODE_TOR_EXECUTABLE to a trusted Tor binary.`)
  const [release, platformTag, expectedSha] = asset
  const root = join(runtimeRoot, "tor", release, platformTag)
  const marker = join(root, ".ready")
  if (await exists(marker)) {
    const current = (await fs.readFile(marker, "utf8")).trim()
    if (current && await exists(current)) return current
  }
  await fs.mkdir(root, { recursive: true })
  const filename = `tor-expert-bundle-${platformTag}-${release}.tar.gz`
  const archive = join(root, filename)
  if (!await exists(archive) || await sha256(archive) !== expectedSha) {
    const temporary = `${archive}.${process.pid}.${randomUUID()}.tmp`
    const response = await fetch(`https://archive.torproject.org/tor-package-archive/torbrowser/${release}/${filename}`, { redirect: "follow", signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`Tor expert bundle download failed with HTTP ${response.status}`)
    await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
    const actual = await sha256(temporary)
    if (actual !== expectedSha) { await fs.rm(temporary, { force: true }); throw new Error(`Tor bundle checksum mismatch: expected ${expectedSha}, got ${actual}`) }
    await fs.rm(archive, { force: true })
    await fs.rename(temporary, archive)
  }
  const extract = join(root, "extract")
  await fs.rm(extract, { recursive: true, force: true })
  await fs.mkdir(extract, { recursive: true })
  await tar.x({ file: archive, cwd: extract })
  const binary = await findExecutable(extract)
  if (!binary) throw new Error("The verified Tor expert bundle did not contain a Tor executable")
  if (platform() !== "win32") await fs.chmod(binary, 0o755)
  await fs.writeFile(marker, binary, { encoding: "utf8", mode: 0o600 })
  return binary
}

export function controlCommand(port, cookieFile, command, timeoutMs = 8_000) {
  return fs.readFile(cookieFile).then((cookie) => new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    let buffer = ""
    let authenticated = false
    const response = []
    const timer = setTimeout(() => socket.destroy(new Error(`Tor control command timed out after ${timeoutMs}ms`)), timeoutMs)
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value) }
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`AUTHENTICATE ${cookie.toString("hex")}\r\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        if (!authenticated) {
          if (!line.startsWith("250")) return finish(new Error(`Tor cookie authentication failed: ${line}`))
          authenticated = true
          socket.write(`${command}\r\n`)
          continue
        }
        response.push(line)
        if (line === "250 OK") return finish(null, response.join("\n"))
        if (line.startsWith("5")) return finish(new Error(`Tor control command failed: ${response.join("\n")}`))
      }
    })
    socket.on("error", (error) => finish(error))
  }))
}

export function torrcContent(runtimeRoot, socksPort, controlPort) {
  const dataDir = join(runtimeRoot, "tor-data")
  const cookie = join(runtimeRoot, "control_auth_cookie")
  const quote = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  return [`SocksPort 127.0.0.1:${socksPort}`, `ControlPort 127.0.0.1:${controlPort}`, `DataDirectory ${quote(dataDir)}`, "CookieAuthentication 1", `CookieAuthFile ${quote(cookie)}`, "ClientOnly 1", "AvoidDiskWrites 1", ""].join("\n")
}

export function launchTor(binary, runtimeRoot, socksPort, controlPort) {
  const dataDir = join(runtimeRoot, "tor-data")
  const cookie = join(runtimeRoot, "control_auth_cookie")
  const torrc = join(runtimeRoot, "torrc")
  return fs.mkdir(dataDir, { recursive: true }).then(async () => {
    await fs.writeFile(torrc, torrcContent(runtimeRoot, socksPort, controlPort), "utf8")
    const child = spawn(binary, ["-f", torrc], { cwd: dirname(binary), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const output = []
    const collect = (chunk) => { output.push(String(chunk)); while (output.join("").length > 8000) output.shift() }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    return { child, cookie, output }
  })
}

export async function waitForTor(controlPort, cookie, child, timeoutMs = 75_000, output = []) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Tor exited during bootstrap with code ${child.exitCode}: ${output.join("").slice(-3000) || "no diagnostic output"}`)
    if (await exists(cookie)) {
      try {
        const detail = await controlCommand(controlPort, cookie, "GETINFO status/bootstrap-phase")
        if (/PROGRESS=100|TAG=done/.test(detail)) return detail
      } catch {}
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error(`Tor did not complete bootstrap within 75 seconds: ${output.join("").slice(-3000) || "no diagnostic output"}`)
}
