// UX-13a: the hiring pool. An account's team (the `agent` table, 02-data-model) is hired from
// these names, one at a time, only when no teammate is free (10-contracts §Claim).

/**
 * About 160 first names: every gender, many cultures, short enough to read on a board card, and
 * none of them a word that also appears in workflows (no "Build", "Test", "Done").
 */
// prettier-ignore
export const AGENT_NAMES: readonly string[] = [
  // West Africa / East Africa / Southern Africa
  'Ada', 'Amara', 'Chidi', 'Kofi', 'Ama', 'Kwame', 'Ngozi', 'Tunde', 'Zuri', 'Baraka',
  'Wanjiru', 'Juma', 'Thandi', 'Sipho', 'Lerato', 'Femi', 'Abena', 'Nia', 'Obi', 'Asha',
  // Middle East / North Africa / Persia / Turkey
  'Layla', 'Omar', 'Yasmin', 'Karim', 'Noor', 'Samir', 'Leila', 'Tariq', 'Dara', 'Reza',
  'Shirin', 'Emre', 'Elif', 'Yusuf', 'Zeynep', 'Hana', 'Rami', 'Salma',
  // South Asia
  'Priya', 'Arjun', 'Ananya', 'Rohan', 'Meera', 'Vikram', 'Kavya', 'Dev', 'Isha', 'Nikhil',
  'Sana', 'Imran', 'Anjali', 'Ravi', 'Tara', 'Farhan', 'Nadia',
  // East Asia
  'Mei', 'Wei', 'Lin', 'Jun', 'Hiro', 'Yuki', 'Aiko', 'Kenji', 'Haruto', 'Sakura',
  'Min-jun', 'Ji-woo', 'Seo-yeon', 'Ren', 'Xin', 'Bo',
  // Southeast Asia / Pacific
  'Linh', 'Minh', 'Thao', 'Bao', 'Siti', 'Rizal', 'Mahina', 'Kai', 'Leilani', 'Tavita',
  'Malia', 'Dewi', 'Arief',
  // Latin America / Iberia
  'Sofia', 'Mateo', 'Valentina', 'Diego', 'Camila', 'Javier', 'Lucia', 'Pablo', 'Ximena',
  'Joaquin', 'Inés', 'Rafael', 'Paloma', 'Tomás', 'Catalina', 'Andrés', 'Marisol', 'Joao',
  'Beatriz', 'Thiago',
  // Europe
  'Elena', 'Luca', 'Giulia', 'Marco', 'Chiara', 'Klaus', 'Greta', 'Lukas', 'Freya',
  'Soren', 'Astrid', 'Nils', 'Ingrid', 'Anya', 'Mikhail', 'Olga', 'Dmitri', 'Zofia',
  'Piotr', 'Katya', 'Niamh', 'Ciaran', 'Siobhan', 'Eamon', 'Rhys', 'Cerys', 'Isla',
  'Callum', 'Margot', 'Hugo', 'Elodie', 'Bastien', 'Agnes', 'Milan',
  // North America / Indigenous / anglophone
  'Avery', 'Jordan', 'Riley', 'Morgan', 'Quinn', 'Casey', 'Rowan', 'Sage', 'Jamie', 'Alex',
  'Ellis', 'Harper', 'Wren', 'Nova', 'Theo', 'Maya', 'Ezra', 'Ruby', 'Miles', 'Iris',
  'Dakota', 'Aiyana', 'Takoda', 'Winona', 'Kieran', 'Simone', 'Marcus', 'Imani', 'Andre',
  'Zora', 'Grace', 'Felix', 'Hazel', 'Oscar', 'June', 'Arlo',
];

/** FNV-1a, 32-bit. Stable across platforms (only Math.imul and unsigned shifts). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The pool in the order a ticket tries to hire from it: from `fnv1a('name:<ticket id>')` (the seed
 * web's `agentName()` used, so a ticket's first hire is the name it showed before UX-13a), then
 * forward, wrapping around.
 */
export function hireOrder(ticketId: string): string[] {
  const start = fnv1a(`name:${ticketId}`) % AGENT_NAMES.length;
  return [...AGENT_NAMES.slice(start), ...AGENT_NAMES.slice(0, start)];
}

/** The first name of `hireOrder(ticketId)` not in `taken`; null when the whole pool is taken. */
export function hireName(ticketId: string, taken: ReadonlySet<string>): string | null {
  return hireOrder(ticketId).find((n) => !taken.has(n)) ?? null;
}
