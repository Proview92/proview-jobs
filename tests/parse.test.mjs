// Run: node tests/parse.test.mjs
import assert from "node:assert/strict";
import { isJobMessage, parseJob, parseDue, parsePart } from "../supabase/functions/whatsapp-webhook/parse.ts";

const T = "2026-11-20"; // a Friday
let n = 0; const ok = (name, fn) => { fn(); n++; };

ok("trigger", () => {
  for (const s of ["Job: fix till", "job fix till", "#job fix till", "New job - fix till", "JOB\nfix till", "  *Job:* fix"]) assert.equal(isJobMessage(s), true, s);
  for (const s of ["Good job today", "jobs for tomorrow?", "hello", "", "jobcentre visit", "Can you do the job: x"]) assert.equal(isJobMessage(s), false, s);
});

ok("full message", () => {
  const j = parseJob(`Job: Install 4 cameras at Al Noor Cafe
Customer: Ahmed 050 123 4567
Address: Shop 3, Al Wasl Road
Due: tomorrow 3pm
Priority: urgent
Assign: Ravi
Tasks: mount cameras, run cable, set up recorder
Parts: 4x dome camera, 1 recorder, 100m cat6 cable
Bring the tall ladder`, T);
  assert.equal(j.title, "Install 4 cameras at Al Noor Cafe");
  assert.equal(j.customer_name, "Ahmed");
  assert.equal(j.customer_phone, "050 123 4567");
  assert.equal(j.address, "Shop 3, Al Wasl Road");
  assert.equal(j.due_date, "2026-11-21");
  assert.equal(j.priority, "urgent");
  assert.equal(j.assign, "Ravi");
  assert.deepEqual(j.tasks, ["mount cameras", "run cable", "set up recorder"]);
  assert.deepEqual(j.parts, [{ qty: 4, name: "dome camera" }, { qty: 1, name: "recorder" }, { qty: 1, name: "100m cat6 cable" }]);
  assert.equal(j.description, "Time: 3pm\nBring the tall ladder");
});

ok("bulleted lists over several lines", () => {
  const j = parseJob(`#job
Replace receipt printer at Costa
Tasks:
- remove old printer
- fit new one
2) test print
Parts:
• Epson TM-T20 x1
• USB cable (2)
Notes: back door code 4411
Phone: +44 7700 900123`, T);
  assert.equal(j.title, "Replace receipt printer at Costa");
  assert.deepEqual(j.tasks, ["remove old printer", "fit new one", "test print"]);
  assert.deepEqual(j.parts, [{ qty: 1, name: "Epson TM-T20" }, { qty: 2, name: "USB cable" }]);
  assert.equal(j.description, "back door code 4411");
  assert.equal(j.customer_phone, "+44 7700 900123");
});

ok("title only, loose text, urgent word", () => {
  const j = parseJob("Job fix the till at Bella's ASAP\nmeet Sam at 10:30\nhttps://maps.app.goo.gl/x", T);
  assert.equal(j.title, "fix the till at Bella's ASAP");
  assert.equal(j.priority, "urgent");
  assert.equal(j.description, "meet Sam at 10:30\nhttps://maps.app.goo.gl/x");
  assert.equal(parseJob("hello there", T), null);
  assert.equal(parseJob("fix till\nDue: mon", T, false).due_date, "2026-11-23");
  assert.equal(parseJob("Job:", T).title, "");
});

ok("whatsapp formatting and unreadable due date", () => {
  const j = parseJob("*Job:* Router swap\n*Client:* Mrs Khan - 07700900123\n*Due:* when she calls\n*Assigned to:* to Sam", T);
  assert.equal(j.title, "Router swap");
  assert.equal(j.customer_name, "Mrs Khan");
  assert.equal(j.customer_phone, "07700900123");
  assert.equal(j.due_date, null);
  assert.equal(j.description, "Due: when she calls");
  assert.equal(j.assign, "Sam");
});

ok("dates", () => {
  const d = (s) => parseDue(s, T);
  assert.equal(d("today"), "2026-11-20");
  assert.equal(d("Tomorrow morning"), "2026-11-21");
  assert.equal(d("day after tomorrow"), "2026-11-22");
  assert.equal(d("friday"), "2026-11-27");
  assert.equal(d("next tue"), "2026-11-24");
  assert.equal(d("25/11"), "2026-11-25");
  assert.equal(d("25/11/26"), "2026-11-25");
  assert.equal(d("3.1"), "2027-01-03");
  assert.equal(d("2026-12-01"), "2026-12-01");
  assert.equal(d("25th Nov"), "2026-11-25");
  assert.equal(d("December 2nd"), "2026-12-02");
  assert.equal(d("5 jan 2027"), "2027-01-05");
  assert.equal(d("in 3 days"), "2026-11-23");
  assert.equal(d("in 2 weeks"), "2026-12-04");
  assert.equal(d("31/02"), null);
  assert.equal(d("whenever"), null);
});

ok("parts", () => {
  assert.deepEqual(parsePart("4x dome camera"), { qty: 4, name: "dome camera" });
  assert.deepEqual(parsePart("4 x dome camera"), { qty: 4, name: "dome camera" });
  assert.deepEqual(parsePart("2 pcs HDMI lead"), { qty: 2, name: "HDMI lead" });
  assert.deepEqual(parsePart("HDMI lead x3"), { qty: 3, name: "HDMI lead" });
  assert.deepEqual(parsePart("4K monitor"), { qty: 1, name: "4K monitor" });
  assert.deepEqual(parsePart("100m cat6"), { qty: 1, name: "100m cat6" });
  assert.deepEqual(parsePart("0.5 roll tape"), { qty: 0.5, name: "roll tape" });
});

console.log("parse:", n, "groups passed");
