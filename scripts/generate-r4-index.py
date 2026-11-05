#!/usr/bin/env python3
"""Derive a reproducible type index from the pinned HL7 R4 core package.

No package code is executed and archive members are never extracted to disk.
The generated index aids discovery and egress typing; it is not a validator.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

SOURCE = 'https://packages2.fhir.org/web/hl7.fhir.r4.core-4.0.1.tgz'
SHA256 = 'b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091'
ROOT = Path(__file__).resolve().parent.parent
SYSTEM_TYPE = 'http://hl7.org/fhirpath/System.'
FHIR_TYPE = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type'
# Element is the abstract base of every datatype and of each `_primitive`
# companion. It has no `derivation`, so it is admitted explicitly; without it
# primitive-extension paths would resolve to a context absent from the index.
BASE_TYPES = {'Element'}
# FHIRPath system types used when no fhir-type extension is declared.
SYSTEM_FALLBACK = {'String': 'string', 'Boolean': 'boolean', 'Integer': 'integer', 'Decimal': 'decimal', 'Date': 'date', 'DateTime': 'dateTime', 'Time': 'time'}


def type_code(item, owner=None):
    """Map FHIRPath System.* codes to their declared FHIR type (e.g. Extension.url -> uri).

    A primitive's own `value` element is typed as that primitive (canonical.value
    is a canonical), because R4 4.0.1 declares the generic `string` there.
    """
    code = item.get('code')
    if code and code.startswith(SYSTEM_TYPE):
        if owner:
            return owner
        for extension in item.get('extension', []):
            if extension.get('url') == FHIR_TYPE and isinstance(extension.get('valueUrl'), str):
                return extension['valueUrl']
        return SYSTEM_FALLBACK.get(code[len(SYSTEM_TYPE):], code)
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT / '.local/hl7.fhir.r4.core-4.0.1.tgz')
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    if args.download:
        with urllib.request.urlopen(SOURCE, timeout=30) as response:
            body = response.read(10 * 1024 * 1024 + 1)
        if len(body) > 10 * 1024 * 1024:
            raise ValueError('FHIR package exceeds the download limit')
        args.input.parent.mkdir(parents=True, exist_ok=True)
        args.input.write_bytes(body)
    if hashlib.sha256(args.input.read_bytes()).hexdigest() != SHA256:
        raise ValueError('FHIR package hash differs from the reviewed input')
    definitions = {}
    with tarfile.open(args.input, 'r:gz') as archive:
        for member in archive:
            if not member.isfile() or not member.name.startswith('package/StructureDefinition-') or not member.name.endswith('.json'):
                continue
            if member.size > 4 * 1024 * 1024:
                raise ValueError('StructureDefinition exceeds the member limit')
            definition = json.load(archive.extractfile(member))
            name = definition.get('type')
            base = name in BASE_TYPES and 'derivation' not in definition and 'baseDefinition' not in definition
            if (definition.get('derivation') != 'specialization' and not base) or definition.get('id') != name or definition.get('kind') not in ('resource', 'complex-type', 'primitive-type'):
                continue
            elements = {}
            for element in definition.get('snapshot', {}).get('element', []):
                path = element['path'].partition('.')[2]
                if not path:
                    continue
                types = []
                owner = name if definition.get('kind') == 'primitive-type' and path == 'value' else None
                for item in element.get('type', []):
                    code = type_code(item, owner)
                    if code and code not in types:
                        types.append(code)
                entry = {'min': element.get('min', 0), 'max': element.get('max', '1'), 'types': types}
                if element.get('isModifier'):
                    entry['modifier'] = True
                if element.get('contentReference'):
                    entry['content_reference'] = element['contentReference']
                if element.get('short'):
                    entry['short'] = element['short'][:240]
                if element.get('binding', {}).get('valueSet'):
                    entry['binding'] = {key: element['binding'][key] for key in ('strength', 'valueSet') if key in element['binding']}
                targets = sorted({target for item in element.get('type', []) for target in item.get('targetProfile', [])})
                if targets:
                    entry['targets'] = targets
                elements[path] = entry
            definitions[name] = {'url': definition['url'], 'kind': definition['kind'], 'elements': dict(sorted(elements.items()))}
    result = {'package': 'hl7.fhir.r4.core', 'version': '4.0.1', 'license': 'CC0-1.0', 'source_url': SOURCE, 'source_sha256': SHA256, 'definitions': dict(sorted(definitions.items()))}
    destination = ROOT / 'packages/core/src/generated/r4-index.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    # One element per line keeps generated diffs inspectable without a large
    # pretty-print expansion. Ordering and encoding are deterministic.
    lines = ['{'] + ['  ' + json.dumps(key) + ': ' + json.dumps(value) + ',' for key, value in result.items() if key != 'definitions']
    lines.append('  "definitions": {')
    for index, (name, definition) in enumerate(result['definitions'].items()):
        lines.append('    ' + json.dumps(name) + ': {"url": ' + json.dumps(definition['url']) + ', "kind": ' + json.dumps(definition['kind']) + ', "elements": {')
        for offset, (path, element) in enumerate(definition['elements'].items()):
            lines.append('      ' + json.dumps(path) + ': ' + json.dumps(element, ensure_ascii=False, separators=(',', ':')) + (',' if offset + 1 < len(definition['elements']) else ''))
        lines.append('    }}' + (',' if index + 1 < len(definitions) else ''))
    lines.extend(['  }', '}', ''])
    destination.write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'definitions': len(definitions), 'elements': sum(len(d['elements']) for d in definitions.values()), 'bytes': destination.stat().st_size, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
