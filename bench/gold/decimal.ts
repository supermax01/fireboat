// Exact decimals from JSON number lexemes. Never goes through a binary float.

export interface Decimal { negative: boolean; digits: bigint; exponent: number } // value = (-1)^neg * digits * 10^exponent

const LEXEME = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

export function isDecimalLexeme(text: string): boolean {
  return LEXEME.test(text);
}

export function parseDecimal(text: string): Decimal {
  const m = LEXEME.exec(text);
  if (!m) throw new Error(`not a JSON number lexeme: ${JSON.stringify(text)}`);
  const frac = m[3] ?? '';
  const exp = Number(m[4] ?? '0');
  if (!Number.isSafeInteger(exp)) throw new Error(`exponent out of range: ${text}`);
  const digits = BigInt(m[2]! + frac);
  return normalise({ negative: m[1] === '-' && digits !== 0n, digits, exponent: exp - frac.length });
}

function normalise(d: Decimal): Decimal {
  if (d.digits === 0n) return { negative: false, digits: 0n, exponent: 0 };
  let { digits, exponent } = d;
  while (digits % 10n === 0n) { digits /= 10n; exponent++; }
  return { negative: d.negative, digits, exponent };
}

/** Plain notation, no exponent, no trailing fractional zeros: "12.3400" -> "12.34", "1e-3" -> "0.001", "-0.0" -> "0". */
export function canonicalDecimal(text: string): string {
  const d = parseDecimal(text);
  const sign = d.negative ? '-' : '';
  const s = d.digits.toString();
  if (d.exponent >= 0) return sign + s + '0'.repeat(d.exponent);
  const point = s.length + d.exponent;
  return point > 0 ? `${sign}${s.slice(0, point)}.${s.slice(point)}` : `${sign}0.${'0'.repeat(-point)}${s}`;
}

export function compareDecimal(a: string, b: string): number {
  const x = parseDecimal(a), y = parseDecimal(b);
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const e = Math.min(x.exponent, y.exponent);
  const xv = x.digits * 10n ** BigInt(x.exponent - e);
  const yv = y.digits * 10n ** BigInt(y.exponent - e);
  const c = xv === yv ? 0 : xv < yv ? -1 : 1;
  return x.negative ? -c : c;
}

export const decimalEquals = (a: string, b: string): boolean => compareDecimal(a, b) === 0;

/** Eligible (bench/GOLD-RULINGS.md, G3) when a binary-float round trip (shortest form, as JavaScript prints it) changes the lexeme. */
export function lexemeChangedByFloat(text: string): boolean {
  if (!isDecimalLexeme(text)) return false;
  return String(Number(text)) !== text;
}
