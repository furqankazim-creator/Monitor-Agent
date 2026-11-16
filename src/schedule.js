// Fixed daily check times ("check at 9 am, 12 pm, 3 pm, 5:30 pm") instead of continuous interval checking.

/** Accepts "9pm", "12 pm", "5.30pm", "17:30", "09:00 AM" ... as a list or comma/semicolon/newline separated string. Returns sorted unique "HH:MM". */
export function parseTimes(input) {
  const tokens = (Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const out = new Set();
  for (const tok of tokens) {
    const m = tok.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
    if (!m) throw new Error(`"${tok}" is not a valid time (examples: 9am, 12:00, 3 pm, 5.30pm)`);
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = m[3] ? m[3][0] : null;
    if (min > 59) throw new Error(`"${tok}": minutes must be 00-59`);
    if (ap) { if (h < 1 || h > 12) throw new Error(`"${tok}": hour must be 1-12 with am/pm`); if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0; }
    else if (h > 23) throw new Error(`"${tok}": hour must be 0-23`);
    out.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  if (out.size > 24) throw new Error('At most 24 check times per day');
  return [...out].sort();
}

/** Next scheduled instant (UTC ms) strictly after `fromMs`, for times given in a fixed UTC offset (minutes, e.g. +240 for UTC+4). */
export function nextSlot(times, tzOffsetMin, fromMs = Date.now()) {
  if (!times?.length) return null;
  const off = (tzOffsetMin || 0) * 60000; const dayStartLocal = Math.floor((fromMs + off) / 86400000) * 86400000;
  for (let d = 0; d <= 2; d++) {
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const utc = dayStartLocal + d * 86400000 + h * 3600000 + m * 60000 - off;
      if (utc > fromMs + 1000) return utc;
    }
  }
  return null;
}
export const isScheduled = (config) => Array.isArray(config?.check_times) && config.check_times.length > 0;
export const RECHECK_CATEGORIES = ['availability', 'api_failure', 'database', 'performance', 'workflow', 'dns', 'ssl', 'render', 'content_change'];
