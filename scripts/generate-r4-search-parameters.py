#!/usr/bin/env python3
"""Derive the pinned R4 SearchParameter catalog from the HL7 R4 core package.

Spec: proposals/m3b-spec.md section 1 (Q work package). No package code is
executed and archive members are never extracted to disk. The catalog records
typing evidence only; it never manufactures source-execution evidence, and no
expression is evaluated.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

SOURCE = 'https://packages2.fhir.org/web/hl7.fhir.r4.core-4.0.1.tgz'
SHA256 = 'b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091'
ROOT = Path(__file__).resolve().parent.parent
GENERATOR_REVISION = 'generate-r4-search-parameters/2'
# Exactly the three example-named members are excluded from the executable
# catalog (spec section 1). Excluding them resolves both (code, base)
# collisions in the archive: (_id, Resource) and (subject, Condition).
EXCLUDED_IDS = {'example', 'example-extension', 'example-reference'}
MEMBER_LIMIT = 256 * 1024
TYPES = {'number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special'}


def bounded_strings(value, limit, item_limit):
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError('SearchParameter array exceeds the generator bound')
    out = []
    for item in value:
        if not isinstance(item, str) or len(item) > item_limit:
            raise ValueError('SearchParameter string exceeds the generator bound')
        out.append(item)
    return out


def normalize(definition, member_sha):
    url = definition.get('url')
    code = definition.get('code')
    typ = definition.get('type')
    if not isinstance(url, str) or len(url) > 512 or not url.startswith('http://hl7.org/fhir/SearchParameter/'):
        raise ValueError('SearchParameter url out of bounds')
    if not isinstance(code, str) or not code or len(code) > 80:
        raise ValueError('SearchParameter code out of bounds')
    if typ not in TYPES:
        raise ValueError('SearchParameter type out of bounds')
    description = definition.get('description')
    expression = definition.get('expression')
    version = definition.get('version')
    if description is not None and (not isinstance(description, str) or len(description) > 4096):
        raise ValueError('SearchParameter description out of bounds')
    if expression is not None and (not isinstance(expression, str) or len(expression) > 2048):
        raise ValueError('SearchParameter expression out of bounds')
    entry = {
        'url': url,
        'code': code,
        'base': bounded_strings(definition.get('base', []), 64, 80),
        'type': typ,
        'member_sha256': member_sha,
    }
    if isinstance(version, str) and len(version) <= 80:
        entry['version'] = version
    target = definition.get('target')
    if target is not None:
        entry['target'] = bounded_strings(target, 200, 80)
    comparator = definition.get('comparator')
    if comparator is not None:
        entry['comparator'] = bounded_strings(comparator, 16, 8)
    modifier = definition.get('modifier')
    if modifier is not None:
        entry['modifier'] = bounded_strings(modifier, 16, 80)
    chain = definition.get('chain')
    if chain is not None:
        entry['chain'] = bounded_strings(chain, 16, 80)
    for flag in ('multipleAnd', 'multipleOr'):
        if isinstance(definition.get(flag), bool):
            entry[flag] = definition[flag]
    if expression is not None:
        entry['expression'] = expression
    if description is not None:
        entry['description'] = description
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT / '.local/hl7.fhir.r4.core-4.0.1.tgz')
    args = parser.parse_args()
    if hashlib.sha256(args.input.read_bytes()).hexdigest() != SHA256:
        raise ValueError('FHIR package hash differs from the reviewed input')
    definitions = []
    excluded = []
    with tarfile.open(args.input, 'r:gz') as archive:
        for member in archive:
            if not member.isfile() or not member.name.startswith('package/SearchParameter-') or not member.name.endswith('.json'):
                continue
            if member.size > MEMBER_LIMIT:
                raise ValueError('SearchParameter exceeds the member limit')
            raw = archive.extractfile(member).read()
            definition = json.loads(raw)
            member_sha = hashlib.sha256(raw).hexdigest()
            ident = definition.get('id')
            if ident in EXCLUDED_IDS:
                excluded.append({'id': ident, 'url': definition.get('url'), 'member_sha256': member_sha, 'reason': 'example-named member; never a reviewed selection'})
                continue
            definitions.append(normalize(definition, member_sha))
    definitions.sort(key=lambda d: d['url'])
    excluded.sort(key=lambda d: d['id'])
    if len(excluded) != 3:
        raise ValueError(f'expected exactly 3 excluded example members, found {len(excluded)}')
    # Collision ledger: (code, base) pairs with more than one surviving definition.
    by_pair = {}
    for entry in definitions:
        for base in entry['base']:
            by_pair.setdefault(f"{base}.{entry['code']}", []).append(entry['url'])
    collisions = [{'key': key, 'urls': sorted(urls)} for key, urls in sorted(by_pair.items()) if len(urls) > 1]
    result = {
        'package': 'hl7.fhir.r4.core',
        'version': '4.0.1',
        'license': 'CC0-1.0',
        'source_url': SOURCE,
        'source_sha256': SHA256,
        'generator_revision': GENERATOR_REVISION,
        'selection_rules': [
            'Example-named members (example, example-extension, example-reference) are excluded.',
            'A definition applies to a resource type when base lists that type; base Resource applies to every type.',
            'An exact-base definition is preferred over a Resource-base definition for the same code.',
            '_id therefore resolves to Resource-id, never to the excluded example definition.',
            'A DomainResource base (e.g. _text) is conservatively never applicable; only exact-type and Resource bases apply (Q-18c).',
            'Missing comparator/modifier/target/multipleAnd/multipleOr declarations stay absent (unknown), never permission.',
        ],
        'excluded_examples': excluded,
        'collisions': collisions,
        'definitions': definitions,
    }
    destination = ROOT / 'packages/core/src/generated/r4-search-parameters.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    lines = ['{']
    for key, value in result.items():
        if key == 'definitions':
            continue
        lines.append('  ' + json.dumps(key) + ': ' + json.dumps(value, ensure_ascii=False) + ',')
    lines.append('  "definitions": [')
    for index, entry in enumerate(definitions):
        lines.append('    ' + json.dumps(entry, ensure_ascii=False, separators=(',', ':')) + (',' if index + 1 < len(definitions) else ''))
    lines.extend(['  ]', '}', ''])
    destination.write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'definitions': len(definitions), 'excluded': len(excluded), 'collisions': len(collisions), 'bytes': destination.stat().st_size, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
