// Turns a WhatsApp message into a job. No network, no Deno APIs: runs anywhere.
//
//   Job: Install 4 cameras at Al Noor Cafe
//   Customer: Ahmed 050 123 4567
//   Address: Shop 3, Al Wasl Road
//   Due: tomorrow
//   Priority: urgent
//   Assign: Ravi
//   Tasks: mount cameras, run cable, set up recorder
//   Parts: 4x dome camera, 1 recorder, 100m cat6 cable

export interface ParsedPart { name: string; qty: number }
export interface ParsedJob {
  title: string;
  description: string;
  customer_name: string;
  customer_phone: string;
  address: string;
  due_date: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  assign: string;
  tasks: string[];
  parts: ParsedPart[];
}

const TRIGGER = /^[\s*_~`]*(?:#\s*job|new\s+job|job)(?![a-z0-9])[\s*_~`]*[:\-–—.]?[\s*_~`]*/i;

/** A message counts as a job only when it starts with "job", "#job" or "new job". */
export function isJobMessage(text: string): boolean {
  return TRIGGER.test(text || "");
}

const LABELS: Record<string, string> = {};
function lab(kind: string, names: string) { for (const n of names.split("|")) LABELS[n] = kind; }
lab("title", "title|job|job title|subject");
lab("customer", "customer|client|customer name|client name|name");
lab("phone", "phone|mobile|tel|telephone|contact|number|customer phone|phone number|contact number|mob");
lab("address", "address|location|site|where|addr");
lab("due", "due|date|when|deadline|due date|by|on");
lab("priority", "priority|urgency");
lab("assign", "assign|assigned|assign to|assigned to|assignee|staff|tech|technician|engineer|for");
lab("tasks", "tasks|task|todo|to do|to-do|work|checklist|steps");
lab("parts", "parts|part|materials|material|items|equipment|parts required|parts needed|stock");
lab("notes", "notes|note|details|description|desc|info|comments|comment");

const PHONE = /\+?\d[\d\s\-()]{5,}\d/;
const BULLET = /^\s*(?:[-*•·▪◦]|\d{1,2}[.)])\s+/;

function clean(s: string): string { return s.replace(/\s+/g, " ").trim(); }

function splitList(v: string): string[] {
  return v.split(/[,;\n]/).map((x) => clean(x.replace(BULLET, ""))).filter(Boolean);
}

export function parsePart(raw: string): ParsedPart | null {
  const s = clean(raw.replace(BULLET, ""));
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:[x×]\s*|(?:pcs?|nos?|units?)\.?\s+|\s+)(\S.*)$/i);
  if (m && Number(m[1]) > 0) return { qty: Number(m[1]), name: clean(m[2]) };
  m = s.match(/^(.*\S)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (m && Number(m[2]) > 0) return { qty: Number(m[2]), name: clean(m[1]) };
  m = s.match(/^(.*\S)\s*\(\s*(\d+(?:\.\d+)?)\s*\)$/);
  if (m && Number(m[2]) > 0) return { qty: Number(m[2]), name: clean(m[1]) };
  return { qty: 1, name: s };
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(todayISO: string, n: number): string {
  const d = new Date(todayISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return iso(dt);
}
// A day and month with no year means the next time that date comes round (allowing a week of hindsight).
function nearestYear(todayISO: string, m: number, d: number): string | null {
  const y = Number(todayISO.slice(0, 4));
  const a = ymd(y, m, d);
  if (!a) return null;
  return a < addDays(todayISO, -7) ? ymd(y + 1, m, d) : a;
}
function fullYear(y: number): number { return y < 100 ? 2000 + y : y; }

/** "tomorrow", "friday", "25/11", "25 Nov", "2026-11-25", "in 3 days" -> yyyy-mm-dd, or null. */
export function parseDue(raw: string, todayISO: string): string | null {
  const s = (raw || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2}|\d{4}))?\b/))) {
    return m[3] ? ymd(fullYear(+m[3]), +m[2], +m[1]) : nearestYear(todayISO, +m[2], +m[1]);
  }
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
  if ((m = s.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? " + mon + "(?: (\\d{4}))?\\b")))) {
    const mo = MONTHS.indexOf(m[2]) + 1;
    return m[3] ? ymd(+m[3], mo, +m[1]) : nearestYear(todayISO, mo, +m[1]);
  }
  if ((m = s.match(new RegExp("\\b" + mon + " (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?\\b")))) {
    const mo = MONTHS.indexOf(m[1]) + 1;
    return m[3] ? ymd(+m[3], mo, +m[2]) : nearestYear(todayISO, mo, +m[2]);
  }
  if (/\bday after (tomorrow|tmrw|tmr)\b/.test(s)) return addDays(todayISO, 2);
  if (/\b(today|tonight|now|asap|this (morning|afternoon|evening))\b/.test(s)) return todayISO;
  if (/\b(tomorrow|tmrw|tmr|tomorow|tommorow)\b/.test(s)) return addDays(todayISO, 1);
  if ((m = s.match(/\bin (\d{1,3}) (day|week)s?\b/))) return addDays(todayISO, +m[1] * (m[2] === "week" ? 7 : 1));
  if (/\bnext week\b/.test(s)) return addDays(todayISO, 7);
  if ((m = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/))) {
    const want = DAYS.findIndex((d) => d.startsWith(m![1]));
    const have = new Date(todayISO + "T00:00:00Z").getUTCDay();
    let n = (want - have + 7) % 7;
    if (n === 0) n = 7;
    return addDays(todayISO, n);
  }
  return null;
}

function parsePriority(v: string): ParsedJob["priority"] | null {
  const s = v.toLowerCase();
  if (/\b(urgent|asap|emergency|critical|immediately)\b/.test(s)) return "urgent";
  if (/\b(high|important)\b/.test(s)) return "high";
  if (/\b(low|whenever|no rush)\b/.test(s)) return "low";
  if (/\b(normal|medium|med|standard|regular)\b/.test(s)) return "normal";
  return null;
}

/** todayISO is today's date (yyyy-mm-dd) in the business's own time zone. */
export function parseJob(text: string, todayISO: string, needTrigger = true): ParsedJob | null {
  const src = (text || "").replace(/\r/g, "").replace(/[\u200e\u200f\u202a-\u202e]/g, "");
  if (needTrigger && !isJobMessage(src)) return null;
  const body = src.replace(TRIGGER, "");
  const job: ParsedJob = {
    title: "", description: "", customer_name: "", customer_phone: "", address: "",
    due_date: null, priority: "normal", assign: "", tasks: [], parts: [],
  };
  const notes: string[] = [];
  let prioritySet = false;
  let mode: "" | "tasks" | "parts" | "notes" = "";

  const addTask = (v: string) => { for (const t of splitList(v)) job.tasks.push(t); };
  const addPart = (v: string) => { for (const t of splitList(v)) { const p = parsePart(t); if (p) job.parts.push(p); } };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/[*_~`]/g, "").trim(); // WhatsApp bold / italic marks
    if (!line) { mode = ""; continue; } // a blank line ends a list

    const c = line.indexOf(":");
    const kind = c > 0 ? LABELS[clean(line.slice(0, c).replace(BULLET, "")).toLowerCase()] : undefined;
    if (kind) {
      const v = clean(line.slice(c + 1));
      mode = "";
      if (kind === "title") { if (v) job.title = v; }
      else if (kind === "customer") {
        const ph = v.match(PHONE);
        if (ph) { if (!job.customer_phone) job.customer_phone = clean(ph[0]); job.customer_name = clean(v.replace(ph[0], "").replace(/[\-–,()]+\s*$/, "").replace(/^\s*[\-–,]+/, "")); }
        else job.customer_name = v;
      }
      else if (kind === "phone") { const ph = v.match(PHONE); job.customer_phone = ph ? clean(ph[0]) : v; }
      else if (kind === "address") job.address = v;
      else if (kind === "due") {
        const d = parseDue(v, todayISO);
        if (d) {
          job.due_date = d;
          const t = v.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/i);
          if (t) notes.push("Time: " + t[1]);
        } else if (v) notes.push("Due: " + v);
      }
      else if (kind === "priority") { const p = parsePriority(v); if (p) { job.priority = p; prioritySet = true; } }
      else if (kind === "assign") job.assign = v.replace(/^to\s+/i, "");
      else if (kind === "tasks") { addTask(v); mode = v ? "" : "tasks"; } // a list on following lines only when none is given inline
      else if (kind === "parts") { addPart(v); mode = v ? "" : "parts"; }
      else if (kind === "notes") { if (v) notes.push(v); mode = "notes"; }
      continue;
    }

    if (mode === "tasks") { addTask(line); continue; }
    if (mode === "parts") { addPart(line); continue; }
    if (!job.title) { job.title = clean(line); continue; }
    notes.push(clean(line));
  }

  if (!prioritySet && /\b(urgent|asap|emergency)\b/i.test(body)) job.priority = "urgent";
  job.title = job.title.slice(0, 200);
  job.description = notes.join("\n");
  return job;
}

export const FORMAT_HELP =
  "Start the message with the word Job, then add any of these lines:\n\n" +
  "Job: Install 4 cameras at Al Noor Cafe\n" +
  "Customer: Ahmed 050 123 4567\n" +
  "Address: Shop 3, Al Wasl Road\n" +
  "Due: tomorrow\n" +
  "Priority: urgent\n" +
  "Assign: Ravi\n" +
  "Tasks: mount cameras, run cable, set up recorder\n" +
  "Parts: 4x dome camera, 1 recorder";
