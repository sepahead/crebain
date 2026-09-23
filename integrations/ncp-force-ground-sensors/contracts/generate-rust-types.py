"""Generate fixed Rust DTOs from the owned schema; never accept a peer schema."""
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
FAMILY = sys.argv[1:2] == ['--family']
ARGUMENTS = sys.argv[2:] if FAMILY else sys.argv[1:]
SCHEMA_NAME = 'family.application.schema.v1.json' if FAMILY else 'application.schema.v1.json'
DEFINITIONS = json.loads((ROOT / 'contracts' / SCHEMA_NAME).read_text())['$defs']
BASE_NAMES = set(json.loads((ROOT / 'contracts/application.schema.v1.json').read_text())['$defs']) if FAMILY else set()
NAMES = {'Result': 'SensorResult', 'Command': 'AdvanceTick'}
PENDING = []
DECLARATIONS = []
KNOWN = set()


def pascal(name):
    return ''.join(part[:1].upper() + part[1:] for part in name.split('_'))


def snake(name):
    name = re.sub(r'(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', name).lower()


def resolve(value):
    return DEFINITIONS[value['$ref'].rsplit('/', 1)[1]] if '$ref' in value else value


def rust_type(value, hint):
    if value is False:
        return 'Never'
    if '$ref' in value:
        name = value['$ref'].rsplit('/', 1)[1]
        return NAMES.get(name, name)
    if 'anyOf' in value:
        return 'Option<' + rust_type(value['anyOf'][0], hint) + '>'
    if 'oneOf' in value and any(arm.get('type') == 'null' for arm in value['oneOf']):
        concrete = [arm for arm in value['oneOf'] if arm.get('type') != 'null']
        if len(concrete) != 1:
            raise ValueError('only one concrete nullable family arm is allowed')
        return 'Option<' + rust_type(concrete[0], hint) + '>'
    if 'const' in value:
        return 'bool' if type(value['const']) is bool else 'u64' if type(value['const']) is int else 'String'
    kind = value.get('type')
    if kind in ('integer', 'number', 'boolean', 'string'):
        return {'integer':'u64', 'number':'Finite64', 'boolean':'bool', 'string':'String'}[kind]
    if kind == 'array':
        if 'prefixItems' in value:
            return f'[u64; {len(value["prefixItems"])}]'
        element = rust_type(value['items'], hint + 'Item')
        low, high = value['minItems'], value['maxItems']
        return f'[{element}; {high}]' if low == high and high > 0 else f'Vec<{element}>'
    if kind == 'object' or 'oneOf' in value or 'enum' in value:
        if hint not in KNOWN:
            KNOWN.add(hint)
            PENDING.append((hint, value))
        return hint
    raise ValueError(value)


def members(value, prefix, indent, omit_kind=False):
    rows = []
    for key, item in value['properties'].items():
        if omit_kind and key == 'kind':
            continue
        field = snake(key)
        rows.append(indent + f'/// Closed schema member `{key}`.')
        if field != key:
            rows.append(indent + f'#[serde(rename = "{key}")]')
        field_type = rust_type(item, prefix + pascal(key))
        # Keep the sparse due/not-due enum compact without changing its wire value.
        if prefix == 'SensorSlotDue' and key in ('typed_manifest', 'byte_manifest'):
            field_type = f'Box<{field_type}>'
        if FAMILY and omit_kind and (resolve(item).get('type') == 'object' or 'oneOf' in resolve(item)):
            field_type = ('Option<Box<' + field_type[7:-1] + '>>') if field_type.startswith('Option<') else f'Box<{field_type}>'
        if FAMILY and omit_kind and field_type.startswith('['):
            array = resolve(item)
            if 'items' in array and resolve(array['items']).get('type') == 'object':
                field_type = f'Box<{field_type}>'
        rows.append(indent + f'pub {field}: {field_type},')
    return rows


def declaration(name, value):
    head = [f'/// Closed installed `{name}` value; semantic bounds remain in the owning schema.']
    if value is False:
        return head + [f'pub type {name} = Never;']
    if value.get('type') == 'array':
        return head + [f'pub type {name} = {rust_type(value, name)};']
    if value.get('type') in ('integer', 'number', 'boolean', 'string'):
        return head + [f'pub type {name} = {rust_type(value, name)};']
    head.append('#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]')
    if 'enum' in value:
        if any(not isinstance(item, str) for item in value['enum']):
            raise ValueError('family enums must contain only string literals')
        head += [f'pub enum {name} {{']
        for item in value['enum']:
            head += [f'    /// Closed `{item}` value.', f'    #[serde(rename = "{item}")]', f'    {pascal(item)},']
        return head + ['}']
    if 'oneOf' in value:
        head += ['#[serde(tag = "kind", deny_unknown_fields)]', f'pub enum {name} {{']
        for arm in value['oneOf']:
            arm = resolve(arm)
            tag = arm['properties']['kind']['const']
            variant = pascal(tag)
            head += [f'    /// Closed `{tag}` variant.', f'    #[serde(rename = "{tag}")]', f'    {variant} {{']
            head += [line.replace('pub ', '', 1) for line in members(arm, name + variant, '        ', True)]
            head.append('    },')
        return head + ['}']
    return head + ['#[serde(deny_unknown_fields)]', f'pub struct {name} {{'] + members(value, name, '    ') + ['}']


for name, value in DEFINITIONS.items():
    if name in ('BufferBinding', 'BufferManifest') or name in BASE_NAMES:
        continue
    renamed = NAMES.get(name, name)
    KNOWN.add(renamed)
    PENDING.append((renamed, value))
while PENDING:
    name, value = PENDING.pop(0)
    DECLARATIONS.extend(declaration(name, value) + [''])
imports = ['use ncp_local::modular_buffer::BufferBinding;', 'use crate::types::*;', 'use crate::Finite64;', ''] if FAMILY else [
    'use ncp_local::modular_buffer::BufferManifest;', 'use crate::Finite64;', '',
    '/// Uninhabited import and forbidden scene-solid payload.',
    '#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]', 'pub enum Never {}', '',
]
text = '\n'.join([
    f'//! Fixed application DTOs generated from `contracts/{SCHEMA_NAME}`.',
    'use serde::{Deserialize, Serialize};',
    *imports,
    *DECLARATIONS,
])
text = subprocess.run(['rustfmt', '--edition', '2021', '--emit', 'stdout'],
                      input=text, text=True, capture_output=True, check=True).stdout
target = ROOT / ('rust/src/family_types.rs' if FAMILY else 'rust/src/types.rs')
if ARGUMENTS == ['--check']:
    if target.read_text() != text:
        raise SystemExit('fixed generated Rust DTOs drifted')
elif ARGUMENTS:
    raise SystemExit('only --check is supported')
else:
    target.write_text(text)
