// Tiny CSV serializer — no dependency. Handles quotes, commas, newlines, BOM for Excel.

// CSV-formula-injection guard. Excel/Sheets/Numbers will execute any cell that
// starts with =, +, -, @, \t, \r as a formula — turning an exported contact
// name like `=cmd|'/c calc'!A1` into remote code execution on the analyst's
// machine. Prefix a single quote (the OWASP-recommended neutralizer) so the
// cell renders as text. Also strip a leading + from phone numbers since Excel
// would otherwise treat `+254...` as a formula too.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function neutralizeFormula(str) {
  return FORMULA_TRIGGER.test(str) ? `'${str}` : str;
}

function escape(value) {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  str = neutralizeFormula(str);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from rows.
 * @param {Array<{key: string, label: string, get?: (row) => any}>} columns
 * @param {Array<object>} rows
 * @returns {string}
 */
function toCsv(columns, rows) {
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => {
    const value = c.get ? c.get(row) : row[c.key];
    return escape(value);
  }).join(',')).join('\r\n');
  // BOM keeps Excel happy with non-ASCII (e.g. accented African names)
  return '﻿' + header + '\r\n' + body + (body ? '\r\n' : '');
}

function setCsvHeaders(res, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

module.exports = { toCsv, setCsvHeaders };
