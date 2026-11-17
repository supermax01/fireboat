from decimal import Decimal

import pytest

from fbgold.values import (
    canonical,
    hours_between,
    in_half_open,
    js_number_string,
    lexeme_eligible,
    loads,
    parse_instant,
    round_half_up,
    utc_date,
)


def test_loads_keeps_lexemes():
    r = loads('{"a": 12.3400, "b": 7, "c": 1e2, "d": 9007199254740993}')
    assert r == {"a": "12.3400", "b": "7", "c": "1e2", "d": "9007199254740993"}


@pytest.mark.parametrize("lexeme,expected", [
    ("12.3400", "12.34"), ("14", "14"), ("0.0", "0"), ("-0.0", "0"), ("-0.50", "-0.5"),
    ("1e2", "100"), ("1.50E-3", "0.0015"), ("7.0", "7"), ("9007199254740993", "9007199254740993"),
    ("112.41600000000001", "112.41600000000001"),
])
def test_canonical(lexeme, expected):
    assert canonical(lexeme) == expected


@pytest.mark.parametrize("lexeme,js", [
    ("12.3400", "12.34"), ("0.1", "0.1"), ("1e2", "100"), ("1e21", "1e+21"), ("1e-7", "1e-7"),
    ("0.000001", "0.000001"), ("123456789012345678901", "123456789012345680000"),
    ("9007199254740993", "9007199254740992"), ("-2.50", "-2.5"),
])
def test_js_number_string(lexeme, js):
    assert js_number_string(lexeme) == js


@pytest.mark.parametrize("lexeme,eligible", [
    ("12.3400", True), ("1.0", True), ("14", False), ("0.1", False), ("112.41600000000001", False),
    ("9007199254740993", True), ("1e2", True), (None, False), ("NEG", False),
])
def test_lexeme_eligible(lexeme, eligible):
    assert lexeme_eligible(lexeme) is eligible


def test_instants_compare_after_offset_normalisation():
    a = parse_instant("2140-01-01T23:30:00-05:00")
    b = parse_instant("2140-01-02T05:00:00Z")
    assert a.utc < b.utc
    assert a.utc_date() == "2140-01-02"
    assert utc_date("2140-01-01T23:30:00-05:00") == "2140-01-02"
    assert utc_date("2133-03-30") == "2133-03-30"


def test_half_open_window_with_explicit_offsets():
    start = parse_instant("2133-02-01T00:00:00Z")
    end = parse_instant("2133-03-01T00:00:00Z")
    assert in_half_open(parse_instant("2133-02-01T00:00:00Z"), start, end)
    assert in_half_open(parse_instant("2133-01-31T19:00:00-05:00"), start, end)  # = 02-01T00:00Z
    assert not in_half_open(parse_instant("2133-02-28T19:00:00-05:00"), start, end)  # = 03-01T00:00Z
    assert not in_half_open(parse_instant("2133-01-31T23:59:59Z"), start, end)


def test_hours_round_half_up():
    s = parse_instant("2140-01-01T00:00:00Z")
    e = parse_instant("2140-01-01T00:00:18Z")  # 0.005 h exactly
    assert round_half_up(hours_between(s, e), 2) == Decimal("0.01")
    e2 = parse_instant("2140-01-02T01:30:00+01:00")  # 24.5 h
    assert canonical(round_half_up(hours_between(s, e2), 2)) == "24.5"
