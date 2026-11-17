"""Lexeme-preserving JSON, canonical decimals and instants.

Numbers are parsed as their source lexemes (``parse_float=str``, ``parse_int=str``) and only ever
compared as ``decimal.Decimal``. No float ever carries a clinical value.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

# ---------------------------------------------------------------- JSON


def loads(text: str) -> Any:
    """Parse JSON keeping every number as its exact source lexeme (a str)."""
    return json.loads(text, parse_float=str, parse_int=str)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


# ---------------------------------------------------------------- decimals

_NUMBER = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")


def is_number_lexeme(s: Any) -> bool:
    return isinstance(s, str) and bool(_NUMBER.match(s))


def to_decimal(lexeme: str) -> Decimal:
    try:
        return Decimal(lexeme)
    except InvalidOperation as exc:  # pragma: no cover - guarded by callers
        raise ValueError(f"not a decimal lexeme: {lexeme!r}") from exc


def canonical(lexeme: str | Decimal) -> str:
    """Plain decimal without exponent and without trailing fractional zeros ("12.3400" -> "12.34")."""
    d = lexeme if isinstance(lexeme, Decimal) else to_decimal(lexeme)
    if d.is_zero():
        return "0"
    d = d.normalize()
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def decimal_equal(a: str, b: str) -> bool:
    return to_decimal(a) == to_decimal(b)


def js_number_string(lexeme: str) -> str:
    """What a JavaScript ``JSON.parse`` then ``String()`` round trip prints for this lexeme.

    Implements ECMAScript Number::toString on the shortest round-trip digits of the IEEE double.
    """
    f = float(lexeme)
    if f == 0:
        return "0"
    if f != f or f in (float("inf"), float("-inf")):  # pragma: no cover - not valid JSON anyway
        return str(f)
    sign = "-" if f < 0 else ""
    d = Decimal(repr(abs(f))).normalize()
    _, digits_t, exp = d.as_tuple()
    digits = "".join(str(x) for x in digits_t)
    k = len(digits)
    n = exp + k  # position of the decimal point relative to the digit string
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        body = digits + "e" + es if k == 1 else digits[0] + "." + digits[1:] + "e" + es
    return sign + body


def lexeme_eligible(lexeme: str | None) -> bool:
    """Eligible when a float round trip would change the recorded lexeme (bench/GOLD-RULINGS.md, G3)."""
    if not is_number_lexeme(lexeme):
        return False
    return js_number_string(lexeme) != lexeme


def round_half_up(d: Decimal, places: int) -> Decimal:
    return d.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------- instants

_DATE_ONLY = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


@dataclass(frozen=True)
class Instant:
    """A FHIR date/dateTime/instant as recorded, with its UTC instant (start of its precision)."""

    text: str
    utc: datetime
    precision: str  # "year" | "month" | "day" | "time"
    has_offset: bool

    def utc_date(self) -> str:
        return self.utc.date().isoformat()


def parse_instant(text: str | None) -> Instant | None:
    if not isinstance(text, str) or not text:
        return None
    if _DATE_ONLY.match(text):
        parts = text.split("-")
        y = int(parts[0])
        m = int(parts[1]) if len(parts) > 1 else 1
        d = int(parts[2]) if len(parts) > 2 else 1
        prec = ("year", "month", "day")[len(parts) - 1]
        # A date has no offset; it is placed at 00:00 UTC (bench/GOLD-RULINGS.md, shared reading G4).
        return Instant(text, datetime(y, m, d, tzinfo=timezone.utc), prec, False)
    s = text[:-1] + "+00:00" if text.endswith("Z") else text
    dt = datetime.fromisoformat(s)
    has_offset = dt.tzinfo is not None
    if not has_offset:
        dt = dt.replace(tzinfo=timezone.utc)
    return Instant(text, dt.astimezone(timezone.utc), "time", has_offset)


def utc_date(text: str | None) -> str | None:
    inst = parse_instant(text)
    if inst is None:
        return None
    if inst.precision == "day" and not inst.has_offset:
        return text  # a plain date is its own calendar day
    return inst.utc_date()


def in_half_open(inst: Instant, start: Instant, end: Instant) -> bool:
    return start.utc <= inst.utc < end.utc


def hours_between(start: Instant, end: Instant) -> Decimal:
    delta: timedelta = end.utc - start.utc
    micros = (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
    return Decimal(micros) / Decimal(3_600_000_000)


def is_date(text: str) -> bool:
    try:
        date.fromisoformat(text)
        return True
    except ValueError:
        return False
