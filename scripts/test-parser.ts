/** Parser sanity harness — run: bun run scripts/test-parser.ts */
import { parseCommand } from '../src/lib/say-it-plainly';

const ctx = {
  currentUser: 'Damon',
  teamNames: ['Damon', 'Josias'],
  tenantNames: ['Apex Piping & Supply', 'Midwest Trade Wholesale', 'Summit Industrial Fasteners', 'Gulf Coast Valve & Fitting'],
  hitlRefs: ['HITL-8092', 'HITL-8093'],
};

const cases: [string, string][] = [
  ['raise my target to 180', 'target:my:180'],
  ['set josias target 165', 'target:Josias:165'],
  ['adjust damon\'s outbound target to 200', 'target:Damon:200'],
  ['approve HITL-8092', 'hitl:HITL-8092:APPROVE'],
  ['override item 8093', 'hitl:HITL-8093:OVERRIDE'],
  ['retry hitl 8092', 'hitl:HITL-8092:RETRY'],
  ['approve hitl-9999', 'unknown (not in queue)'],
  ['invite gulf to the portal', 'invite:Gulf Coast Valve & Fitting'],
  ['issue an invite for Summit Industrial Fasteners', 'invite:Summit Industrial Fasteners'],
  ["message apex saying we're on it today", 'message:Apex Piping & Supply'],
  ['message midwest: contract is out', 'message:Midwest Trade Wholesale'],
  ['invite zzz to the portal', 'unknown (no tenant)'],
  ['delete everything', 'unknown'],
];

let pass = 0;
for (const [input, expected] of cases) {
  const r = parseCommand(input, ctx);
  let actual: string;
  if (r.kind === 'unknown') actual = 'unknown';
  else if (r.kind === 'target') actual = `target:${r.memberName === ctx.currentUser && input.includes('my') ? 'my' : r.memberName}:${r.target}`;
  else if (r.kind === 'hitl') actual = `hitl:${r.ref}:${r.action}`;
  else if (r.kind === 'invite') actual = `invite:${r.tenantName}`;
  else actual = `message:${r.tenantName}`;

  const ok = actual === expected || (expected.startsWith('unknown') && actual === 'unknown');
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${input}" → ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
console.log(`\n${pass}/${cases.length} passed`);
