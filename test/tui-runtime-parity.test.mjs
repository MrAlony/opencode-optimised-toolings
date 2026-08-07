import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const bunCandidates = process.platform === "win32"
  ? [
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "@oven", "bun-windows-x64-baseline", "bin", "bun.exe"),
      join(repositoryRoot, "node_modules", "bun", "bin", "bun.exe"),
    ]
  : [join(repositoryRoot, "node_modules", "bun", "bin", "bun")]
const bun = bunCandidates.find((file) => {
  try { return existsSync(file) && (process.platform !== "win32" || statSync(file).size > 1_000_000) } catch { return false }
}) ?? bunCandidates.at(-1)

function executeTui(root, options = {}) {
  const runtime = mkdtempSync(join(tmpdir(), "alonix-tui-runtime-"))
  const script = `
    import { pathToFileURL } from "node:url";
    import { resolve } from "node:path";
    import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
    ensureRuntimePluginSupport();
    const options=${JSON.stringify(options)};
    const calls={routes:[],slots:[],commands:[],renderers:[],events:[],dialogs:[],navigations:[],disposes:[],kvWrites:[]};
    const initialKv=new Map([
      ["alonix_registered_projects",["C:/work/alpha"]],
      ["alonix_workbench_state",{tabs:[{id:"s1",title:"Alpha work",projectID:"p1",directory:"C:/work/alpha"}],activeID:"s1",mru:["s1"],focus:"main",collapsed:["p1"]}],
      ["alonix_selected_project",{id:"p1",directory:"C:/work/alpha"}],
      ["alonix_dock_open",false],
    ]);
    let kvReady=false;
    const setKvReady=(value)=>{kvReady=value};
    const noop=()=>{};
    const api={
      route:{register(items){calls.routes.push(...items.map(x=>x.name));return noop},navigate(x){calls.navigations.push(x)},current:()=>({type:"home"})},
      slots:{register(x){calls.slots.push(...Object.keys(x.slots||{}));return noop}},
      keymap:{registerLayer(x){for(const command of x.commands||[]){calls.commands.push(command.name);if(["alonix-ide.settings","alonix-ide.workbench","alonix-ide.monitor","alonix-ide.palette","alonix-ide.project.add","alonix-ide.dock"].includes(command.name)) command.run()}return noop}},
      ...(options.renderers === false ? {} : {toolRenderers:{register(name){calls.renderers.push(name);return noop}}}),
      kv:{get ready(){return kvReady},get(k,d){return kvReady&&initialKv.has(k)?initialKv.get(k):d},set(k,v){initialKv.set(k,v);calls.kvWrites.push([k,v])}},
      ui:{toast(){},dialog:{setSize(x){calls.dialogs.push(["size",x])},replace(){calls.dialogs.push(["replace"])},clear(){calls.dialogs.push(["clear"])}},Prompt:()=>null,DialogSelect:()=>null,Slot:()=>null},
      state:{path:{worktree:process.cwd(),directory:process.cwd()},session:{count:()=>0,get:()=>null,diff:()=>[],todo:()=>[],messages:()=>[],status:()=>({type:"idle"}),permission:()=>null,question:()=>null},part:()=>null,lsp:()=>[],mcp:()=>[]},
      client:{project:{list:async()=>({data:[{id:"p1",worktree:"C:/work/alpha",name:"Alpha"}]})},session:{list:async()=>({data:[{id:"s1",title:"Alpha work",projectID:"p1",directory:"C:/work/alpha",time:{updated:Date.now()}}]}),status:async()=>({data:{}}),messages:async()=>({data:[]})}},
      event:{on(name){calls.events.push(name);return noop}},theme:{current:{background:"#111111",foreground:"#eeeeee",primary:"#6699ff"}},renderer:{},
      lifecycle:{onDispose(fn){if(typeof fn==="function")calls.disposes.push(fn)}},app:{version:"1.18.14"}
    };
    let uncaught=null;
    process.on("uncaughtException",error=>{uncaught=error?.stack??String(error)});
    const loaded=await import(pathToFileURL(resolve(${JSON.stringify(root)},"packages/tui/index.tsx")).href+"?runtime-parity="+Date.now());
    let callbackError=null;
    setTimeout(()=>setKvReady(true),100);
    try{await loaded.default.tui(api,{animations:false})}catch(error){callbackError=error?.stack??String(error)}
    await new Promise(done=>setTimeout(done,5_300));
    for(const dispose of calls.disposes.reverse()){try{dispose()}catch{}}
    console.log(JSON.stringify({callbackError,uncaught,calls:{...calls,disposes:calls.disposes.length},kv:Object.fromEntries(initialKv)}));
    if(callbackError||uncaught)process.exitCode=2;
  `
  return new Promise((done) => {
    const child = spawn(bun, ["--eval", script], { cwd: repositoryRoot, env: { ...process.env, OPENCODE_TOOLINGS_DATA_DIR: runtime }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
      let value = null
      try { value = JSON.parse(line ?? "null") } catch {}
      let lifecycle = null
      try {
        const file = readdirSync(runtime).find((name) => name.startsWith("tui-activation-") && name.endsWith(".json"))
        if (file) lifecycle = JSON.parse(readFileSync(join(runtime, file), "utf8"))
      } catch {}
      rmSync(runtime, { recursive: true, force: true })
      done({ code, value, lifecycle, stdout, stderr })
    })
  })
}

test("complete TUI callback remains healthy after its first status poll and interactions stay callable", async () => {
  const targetRoot = process.env.ALONIX_GENERATION || repositoryRoot
  const outcome = await executeTui(targetRoot)
  assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout)
  assert.equal(outcome.value?.callbackError, null)
  assert.equal(outcome.value?.uncaught, null)
  assert.equal(outcome.lifecycle?.status, "active", JSON.stringify(outcome.lifecycle))
  assert.equal(outcome.lifecycle?.stage, "complete", JSON.stringify(outcome.lifecycle))
  assert.equal(outcome.lifecycle?.pollError, undefined, JSON.stringify(outcome.lifecycle))
  assert.deepEqual(outcome.value?.calls.routes, ["alonix-settings", "alonix-workbench"])
  assert.equal(outcome.value?.calls.renderers.length, 16)
  assert.ok(outcome.value?.calls.slots.includes("app_left"))
  assert.ok(outcome.value?.calls.commands.includes("alonix-ide.settings"))
  assert.ok(outcome.value?.calls.navigations.includes("alonix-settings"))
  assert.ok(outcome.value?.calls.navigations.includes("alonix-workbench"))
  assert.ok(outcome.value?.calls.dialogs.some((item) => item[0] === "replace"))
  assert.ok(outcome.value?.calls.disposes >= 18)
  assert.deepEqual(outcome.value?.kv?.alonix_registered_projects, ["C:/work/alpha"])
  assert.deepEqual(outcome.value?.kv?.alonix_workbench_state?.tabs?.map((tab) => tab.id), ["s1"])
  assert.deepEqual(
    outcome.value?.kv?.alonix_workbench_state?.collapsed,
    ["directory:c:/work/alpha"],
    JSON.stringify(outcome.value?.calls?.kvWrites),
  )
  assert.deepEqual(outcome.value?.kv?.alonix_selected_project, { id: "p1", directory: "C:/work/alpha" })
  assert.equal(outcome.value?.kv?.alonix_dock_open, true, "the exercised Dock command toggles the restored false preference")
})

function semanticKv(value) {
  const copy = structuredClone(value)
  const snapshot = copy?.alonix_portfolio_snapshot
  if (snapshot) {
    delete snapshot.savedAt
    for (const session of snapshot.sessions ?? []) {
      if (session?.time) delete session.time.updated
    }
  }
  return copy
}

test("missing host renderer capability is lifecycle-degraded rather than falsely active", async () => {
  const outcome = await executeTui(repositoryRoot, { renderers: false })
  assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout)
  assert.equal(outcome.value?.callbackError, null)
  assert.equal(outcome.lifecycle?.status, "degraded", JSON.stringify(outcome.lifecycle))
  assert.equal(outcome.lifecycle?.stage, "complete-portable", JSON.stringify(outcome.lifecycle))
  assert.equal(outcome.lifecycle?.renderersAvailable, false)
  assert.equal(outcome.lifecycle?.renderersRegistered, 0)
  assert.equal(outcome.lifecycle?.missingCapability, "api.toolRenderers")
})

test("checkout and staged generation restore the same delayed-KV state and registration transcript", async (context) => {
  const generation = process.env.ALONIX_GENERATION
  if (!generation) return context.skip("set ALONIX_GENERATION to compare a staged immutable generation")
  const [checkout, installed] = await Promise.all([executeTui(repositoryRoot), executeTui(generation)])
  assert.equal(checkout.code, 0, checkout.stderr || checkout.stdout)
  assert.equal(installed.code, 0, installed.stderr || installed.stdout)
  for (const key of ["routes", "slots", "commands", "renderers", "events", "dialogs", "navigations"]) {
    assert.deepEqual(installed.value?.calls?.[key], checkout.value?.calls?.[key], `${key} must match exactly`)
  }
  assert.deepEqual(semanticKv(installed.value?.kv), semanticKv(checkout.value?.kv), "restored and migrated IDE state must match semantically")
  assert.equal(installed.lifecycle?.stage, checkout.lifecycle?.stage)
})
