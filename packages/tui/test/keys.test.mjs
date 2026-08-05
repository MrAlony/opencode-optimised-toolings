import test from "node:test"
import assert from "node:assert/strict"
import { applyKeyToQuery, classifyKey, moveIndex, scrollWindow } from "../lib/keys.js"

test("navigation keys map to stable action names", () => {
  assert.equal(classifyKey({ name: "escape" }), "dismiss")
  assert.equal(classifyKey({ name: "return" }), "confirm")
  assert.equal(classifyKey({ name: "enter" }), "confirm")
  assert.equal(classifyKey({ name: "up" }), "up")
  assert.equal(classifyKey({ name: "n", ctrl: true }), "down")
  assert.equal(classifyKey({ name: "p", ctrl: true }), "up")
  assert.equal(classifyKey({ name: "tab" }), "next-pane")
  assert.equal(classifyKey({ name: "tab", shift: true }), "prev-pane")
  assert.equal(classifyKey({ name: "pagedown" }), "page-down")
  assert.equal(classifyKey({ name: "u", ctrl: true }), "clear")
  assert.equal(classifyKey({ name: "a", sequence: "a" }), "insert")
  assert.equal(classifyKey({ name: "f5" }), "ignore")
})

test("query editing handles insertion, deletion, and word removal", () => {
  assert.equal(applyKeyToQuery("ab", { name: "c", sequence: "c" }), "abc")
  assert.equal(applyKeyToQuery("abc", { name: "backspace" }), "ab")
  assert.equal(applyKeyToQuery("abc", { name: "u", ctrl: true }), "")
  assert.equal(applyKeyToQuery("hello world", { name: "w", ctrl: true }), "hello")
  assert.equal(applyKeyToQuery("abc", { name: "up" }), "abc")
  // Control chords must never leak characters into the query.
  assert.equal(applyKeyToQuery("abc", { name: "c", ctrl: true, sequence: "c" }), "abc")
})

test("selection movement wraps and clamps by page", () => {
  assert.equal(moveIndex(0, 5, "up"), 4)
  assert.equal(moveIndex(4, 5, "down"), 0)
  assert.equal(moveIndex(2, 5, "first"), 0)
  assert.equal(moveIndex(2, 5, "last"), 4)
  assert.equal(moveIndex(0, 20, "page-down", 5), 5)
  assert.equal(moveIndex(3, 20, "page-up", 5), 0)
  assert.equal(moveIndex(0, 0, "down"), 0)
  assert.equal(moveIndex(99, 5, "down"), 0)
})

test("scroll window follows the cursor without leaving empty space", () => {
  assert.equal(scrollWindow(0, 0, 5, 20), 0)
  assert.equal(scrollWindow(0, 7, 5, 20), 3)
  assert.equal(scrollWindow(10, 2, 5, 20), 2)
  assert.equal(scrollWindow(0, 19, 5, 20), 15)
  assert.equal(scrollWindow(99, 19, 5, 20), 15)
  assert.equal(scrollWindow(0, 0, 5, 0), 0)
})
