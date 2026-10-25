// Seeded demo shop: "Werkstatt Reuss" — a fictional 12-person sheet-metal & CNC job shop near Lucerne.
// All companies and people are fictional.
import type { Customer, Job, Machine, Operation } from '../../shared/types.js';
import { schedule } from './scheduler.js';

export const SHOP = {
  name: 'Werkstatt Reuss',
  city: 'Emmen LU',
  owner: 'Marco',
  currency: 'CHF',
};

export const machines: Machine[] = [
  { id: 'LAS1', name: 'Fiber laser 6 kW', kind: 'laser' },
  { id: 'PB1', name: 'Press brake 170 t', kind: 'press-brake' },
  { id: 'MILL1', name: '5-axis mill', kind: 'mill-5ax' },
  { id: 'MILL2', name: '3-axis mill', kind: 'mill-3ax' },
];

export const customers: Customer[] = [
  { id: 'brunner', name: 'Brunner Velos', contact: 'Lea Brunner', city: 'Luzern', lang: 'de', email: 'lea@brunner-velos.example', flexible: true, maxDelayDays: 3, delayCostPerDayChf: 25, note: 'Custom bike frames, small batches; said "a few days later is fine if it saves us money".' },
  { id: 'rochat', name: 'Atelier Rochat', contact: 'Julien Rochat', city: 'Fribourg', lang: 'fr', email: 'julien@atelier-rochat.example', flexible: true, maxDelayDays: 4, delayCostPerDayChf: 20, note: 'Furniture designer, exhibition is in three weeks.' },
  { id: 'keller', name: 'Keller Antriebe AG', contact: 'Urs Keller', city: 'Zug', lang: 'de', email: 'einkauf@keller-antriebe.example', flexible: false, maxDelayDays: 0, delayCostPerDayChf: 400, note: 'Line-down risk at their assembly; never move.' },
  { id: 'meier', name: 'Studio Meier Licht', contact: 'Nina Meier', city: 'Basel', lang: 'de', email: 'nina@studio-meier.example', flexible: true, maxDelayDays: 5, delayCostPerDayChf: 15, note: 'Lighting designer, prepaid in full by bank transfer.' },
  { id: 'alpdrone', name: 'Alpine Drone Works', contact: 'Sam Okafor', city: 'Lausanne', lang: 'en', email: 'sam@alpinedrone.example', flexible: false, maxDelayDays: 0, delayCostPerDayChf: 250, note: 'Startup, investor demo date fixed.' },
  { id: 'gasser', name: 'Gasser Gastro Service', contact: 'Peter Gasser', city: 'Kriens', lang: 'de', email: 'peter@gasser-gastro.example', flexible: true, maxDelayDays: 2, delayCostPerDayChf: 35, note: 'Kitchen equipment repairs, stock parts.' },
  { id: 'vuilleumier', name: 'Vuilleumier Horlogerie Outils', contact: 'Claire Vuilleumier', city: 'Le Locle', lang: 'fr', email: 'claire@vuilleumier-outils.example', flexible: false, maxDelayDays: 0, delayCostPerDayChf: 120, note: 'Fixtures for a watch-case line.' },
];

const op = (machineId: string, hours: number, label: string): Operation => ({ machineId, hours, label });

interface SeedJob {
  id: string;
  customerId: string;
  title: string;
  material: string;
  qty: number;
  ops: Operation[];
  releaseDay: number;
  slackDays: number; // due = baseline delivery + slack
  priceChf: number;
  payment: 'authorization' | 'prepaid';
}

// Dispatch order = array order. Laser and press brake are the bottleneck the rush job needs.
const seedJobs: SeedJob[] = [
  { id: 'J-2041', customerId: 'keller', title: 'Motor brackets', material: 'S355 8 mm', qty: 40, ops: [op('LAS1', 3, 'cut'), op('PB1', 4, 'bend')], releaseDay: 0, slackDays: 0, priceChf: 3480, payment: 'authorization' },
  { id: 'J-2042', customerId: 'brunner', title: 'Dropout plates', material: 'Ti Gr5 4 mm', qty: 60, ops: [op('LAS1', 3, 'cut'), op('MILL2', 5, 'mill')], releaseDay: 0, slackDays: 0, priceChf: 2150, payment: 'authorization' },
  { id: 'J-2043', customerId: 'vuilleumier', title: 'Case fixtures', material: 'Alu 7075', qty: 12, ops: [op('MILL1', 14, '5-axis')], releaseDay: 0, slackDays: 1, priceChf: 4200, payment: 'authorization' },
  { id: 'J-2044', customerId: 'rochat', title: 'Table frames', material: 'S235 3 mm', qty: 8, ops: [op('LAS1', 4, 'cut'), op('PB1', 5, 'bend')], releaseDay: 0, slackDays: 0, priceChf: 2680, payment: 'authorization' },
  { id: 'J-2045', customerId: 'gasser', title: 'Hood panels', material: 'Inox 1.4301 1.5 mm', qty: 20, ops: [op('LAS1', 3, 'cut'), op('PB1', 3, 'bend')], releaseDay: 1, slackDays: 0, priceChf: 1540, payment: 'authorization' },
  { id: 'J-2046', customerId: 'alpdrone', title: 'Arm clamps', material: 'Alu 6082', qty: 80, ops: [op('MILL2', 10, 'mill')], releaseDay: 0, slackDays: 1, priceChf: 3900, payment: 'authorization' },
  { id: 'J-2047', customerId: 'meier', title: 'Lamp shades', material: 'Brass 1 mm', qty: 30, ops: [op('LAS1', 4, 'cut'), op('PB1', 4, 'roll/bend')], releaseDay: 1, slackDays: 0, priceChf: 2400, payment: 'prepaid' },
  { id: 'J-2048', customerId: 'keller', title: 'Gear housings', material: 'GG25 castings', qty: 10, ops: [op('MILL1', 16, '5-axis')], releaseDay: 1, slackDays: 1, priceChf: 6200, payment: 'authorization' },
  { id: 'J-2049', customerId: 'brunner', title: 'Head tube gussets', material: 'Steel 25CrMo4 2 mm', qty: 120, ops: [op('LAS1', 5, 'cut'), op('PB1', 3, 'bend')], releaseDay: 2, slackDays: 1, priceChf: 1980, payment: 'authorization' },
  { id: 'J-2050', customerId: 'alpdrone', title: 'Battery trays', material: 'Alu 5754 2 mm', qty: 50, ops: [op('LAS1', 3, 'cut'), op('PB1', 4, 'bend')], releaseDay: 2, slackDays: 1, priceChf: 2760, payment: 'authorization' },
  { id: 'J-2051', customerId: 'vuilleumier', title: 'Polishing jigs', material: 'Tool steel', qty: 6, ops: [op('MILL2', 12, 'mill')], releaseDay: 2, slackDays: 1, priceChf: 3100, payment: 'authorization' },
  { id: 'J-2052', customerId: 'rochat', title: 'Shelf brackets', material: 'S235 4 mm', qty: 64, ops: [op('LAS1', 4, 'cut'), op('PB1', 6, 'bend')], releaseDay: 3, slackDays: 1, priceChf: 2240, payment: 'authorization' },
  { id: 'J-2053', customerId: 'gasser', title: 'Grease filters', material: 'Inox 1 mm', qty: 40, ops: [op('LAS1', 4, 'cut'), op('PB1', 3, 'bend')], releaseDay: 3, slackDays: 1, priceChf: 1720, payment: 'authorization' },
  { id: 'J-2054', customerId: 'keller', title: 'Shaft adapters', material: '42CrMo4', qty: 24, ops: [op('MILL1', 12, '5-axis'), op('MILL2', 6, 'deburr')], releaseDay: 3, slackDays: 1, priceChf: 5400, payment: 'authorization' },
  { id: 'J-2055', customerId: 'meier', title: 'Pendant canopies', material: 'Brass 1.5 mm', qty: 40, ops: [op('LAS1', 3, 'cut'), op('PB1', 4, 'spin/bend')], releaseDay: 4, slackDays: 2, priceChf: 2100, payment: 'prepaid' },
  { id: 'J-2056', customerId: 'alpdrone', title: 'Gimbal mounts', material: 'Alu 7075', qty: 30, ops: [op('MILL1', 10, '5-axis')], releaseDay: 4, slackDays: 1, priceChf: 3650, payment: 'authorization' },
  { id: 'J-2057', customerId: 'brunner', title: 'Rack plates', material: 'Alu 5083 5 mm', qty: 40, ops: [op('LAS1', 4, 'cut'), op('PB1', 4, 'bend')], releaseDay: 5, slackDays: 1, priceChf: 1880, payment: 'authorization' },
  { id: 'J-2058', customerId: 'vuilleumier', title: 'Dial blanks fixture', material: 'Alu 6082', qty: 4, ops: [op('MILL2', 10, 'mill')], releaseDay: 5, slackDays: 1, priceChf: 2300, payment: 'authorization' },
  { id: 'J-2059', customerId: 'gasser', title: 'Counter brackets', material: 'Inox 3 mm', qty: 30, ops: [op('LAS1', 4, 'cut'), op('PB1', 5, 'bend')], releaseDay: 6, slackDays: 1, priceChf: 1660, payment: 'authorization' },
  { id: 'J-2060', customerId: 'keller', title: 'Sensor flanges', material: 'S355 12 mm', qty: 60, ops: [op('LAS1', 5, 'cut'), op('MILL1', 10, '5-axis')], releaseDay: 6, slackDays: 1, priceChf: 4800, payment: 'authorization' },
  { id: 'J-2061', customerId: 'rochat', title: 'Bench legs', material: 'S235 5 mm', qty: 16, ops: [op('LAS1', 4, 'cut'), op('PB1', 5, 'bend')], releaseDay: 7, slackDays: 1, priceChf: 2050, payment: 'authorization' },
  { id: 'J-2062', customerId: 'alpdrone', title: 'Landing skids', material: 'Alu 6061', qty: 40, ops: [op('MILL2', 12, 'mill')], releaseDay: 6, slackDays: 1, priceChf: 2950, payment: 'authorization' },
  { id: 'J-2063', customerId: 'meier', title: 'Wall sconce backs', material: 'Brass 1 mm', qty: 50, ops: [op('LAS1', 4, 'cut'), op('PB1', 4, 'bend')], releaseDay: 8, slackDays: 1, priceChf: 1900, payment: 'prepaid' },
  { id: 'J-2064', customerId: 'vuilleumier', title: 'Bezel fixtures', material: 'Tool steel', qty: 8, ops: [op('MILL1', 12, '5-axis')], releaseDay: 7, slackDays: 1, priceChf: 3800, payment: 'authorization' },
];

let authCounter = 0;
function fakeAuthIds(seed: string, runId: string) {
  authCounter++;
  const n = (authCounter * 7919).toString(36).toUpperCase().padStart(6, '0') + (runId ? `-${runId.toUpperCase()}` : '');
  return { orderId: `SEED-ORD-${seed}-${n}`, authorizationId: `SEED-AUTH-${seed}-${n}` };
}

/** Build the seeded job list. Due dates are derived from the baseline schedule plus per-job slack, so the
 *  baseline is always on time and the shop is "full" (no slack on the bottleneck in week 1).
 *  runId makes the placeholder authorization ids unique per demo run (a reset must never reuse them). */
export function buildSeedJobs(runId = ''): Job[] {
  authCounter = 0;
  const jobs: Job[] = seedJobs.map((s, i) => ({
    id: s.id,
    customerId: s.customerId,
    title: s.title,
    material: s.material,
    qty: s.qty,
    ops: s.ops,
    releaseDay: s.releaseDay,
    dueDay: 99,
    priceChf: s.priceChf,
    payment:
      s.payment === 'authorization'
        ? { kind: 'authorization', ...fakeAuthIds(s.id, runId), authorizedChf: s.priceChf }
        : { kind: 'prepaid', paidChf: s.priceChf, paidVia: 'bank-transfer' },
    status: 'booked',
    seq: (i + 1) * 10,
  }));
  const base = schedule(jobs);
  for (const j of jobs) {
    const s = seedJobs.find((x) => x.id === j.id)!;
    j.dueDay = base.timing[j.id].deliveryDay + s.slackDays;
  }
  return jobs;
}
