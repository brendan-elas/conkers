// Regenerates spec/cells.md from mirror/src/cells.ts. Run: pnpm --filter @conkers/mirror doc:cells
import { writeFileSync } from 'node:fs';
import { renderLayoutDoc, PAYLOAD_SIZE, LAYOUT_VERSION } from '../src/cells.ts';

const head = `# Cell payloads

Generated from \`mirror/src/cells.ts\` by \`pnpm --filter @conkers/mirror doc:cells\`. Do not edit by hand.

Every Conkers cell is a Semantos cell: a 256-byte header built by \`@semantos/cell-ops\`
\`buildCellHeader\` (linearity, typeHash, ownerId, timestamp) and a ${PAYLOAD_SIZE}-byte payload
owned by this spec. Payloads are fixed-offset binary, little-endian, zero-padded.

Common prefix: bytes 0..2 are \`CNK\`, byte 3 is the layout version (${LAYOUT_VERSION}), bytes 4..5 the kind
(u16), bytes 6..7 reserved. Fields start at offset 8.

Signatures are over \`signedBytes\`: the prefix plus every field before the first \`*Sig\` field.
A cell with no signature field is signed as a whole by its header's owner.

## Layouts

`;
writeFileSync(new URL('../../spec/cells.md', import.meta.url), head + renderLayoutDoc());
console.log('spec/cells.md written');

// Also refresh cartridge.json cellTypes[].payloadSchema (the mint endpoint's informal
// {field: {type, tier, description}} shape, see BRAIN-GENERIC-MINT-VERB.md).
import { readFileSync } from 'node:fs';
import { LAYOUTS, CellKind } from '../src/cells.ts';
const manifestUrl = new URL('../../cartridge.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
for (const ct of manifest.cellTypes) {
  const kind = ct.name.replace('conkers.', '') as keyof typeof CellKind;
  const fields = LAYOUTS[kind]; if (!fields) continue;
  ct.payloadSchema = Object.fromEntries(fields.map((f) => [f.name, {
    type: typeof f.type === 'object' ? 'string' : 'integer',
    tier: 'core',
    description: typeof f.type === 'object' ? `${f.type.bytes}-byte hex. ${f.doc}` : `${f.type} LE. ${f.doc}`,
  }]));
  ct.payloadLayout = { kind: CellKind[kind], encoding: 'spec/cells.md' };
}
writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
console.log('cartridge.json payloadSchema refreshed');
