/**
 * Campaign scheduling — ported from WassFlow's campaign-scheduler.ts.
 *
 * Generates the per-recipient send events for a campaign:
 *   - Type 2 (Broadcast): N products × M group JIDs, each product a
 *     "wave", groups shuffled per wave, random delays between sends.
 *   - Type 1 (Bulk product distribution): products shuffled, each
 *     product gets its own shuffled group batch, with a constraint
 *     that consecutive batches don't start with the same group.
 *
 * Pure — no DB, no network. Unit-tested.
 */

export interface CampaignEventInput {
  product_id: string;
  group_jid: string;
  batch_index: number;
  send_order: number;
  scheduled_at: Date;
}

// Fisher-Yates shuffle (ported from WassFlow).
export function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Random integer between min and max (inclusive).
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Type 2 (Broadcast): products in order (each a wave), groups
 * shuffled per wave, random inter/intra-wave delays.
 */
export function generateBroadcastSchedule(
  productIds: string[],
  groupJids: string[],
  startAt: Date,
  delayMinSeconds: number,
  delayMaxSeconds: number,
  jitterSeconds = 120,
  waveDelayMinSeconds = 60,
  waveDelayMaxSeconds = 300,
  waveStartTimes?: Date[]
): CampaignEventInput[] {
  if (productIds.length === 0 || groupJids.length === 0) return [];

  const events: CampaignEventInput[] = [];
  const startJitter = randomInt(0, jitterSeconds);
  let current = new Date(startAt.getTime() + startJitter * 1000);
  let absoluteOrder = 0;

  for (let pIdx = 0; pIdx < productIds.length; pIdx++) {
    const productId = productIds[pIdx];
    const groups = shuffle(groupJids);

    if (waveStartTimes && waveStartTimes[pIdx]) {
      current = new Date(waveStartTimes[pIdx]);
    }

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      if (absoluteOrder > 0) {
        if (gIdx === 0) {
          if (!(waveStartTimes && waveStartTimes[pIdx])) {
            const d = randomInt(waveDelayMinSeconds, waveDelayMaxSeconds);
            current = new Date(current.getTime() + d * 1000);
          }
        } else {
          const d = randomInt(delayMinSeconds, delayMaxSeconds);
          current = new Date(current.getTime() + d * 1000);
        }
      }
      events.push({
        product_id: productId,
        group_jid: groups[gIdx],
        batch_index: pIdx,
        send_order: gIdx,
        scheduled_at: new Date(current),
      });
      absoluteOrder++;
    }
  }

  return events;
}

/**
 * Type 1 (Bulk product distribution): products shuffled, each gets a
 * shuffled group batch (consecutive batches can't share a first/last
 * group), random delays between sends.
 */
export function generateBulkSchedule(
  productIds: string[],
  groupJids: string[],
  startAt: Date,
  delayMinSeconds: number,
  delayMaxSeconds: number,
  jitterSeconds = 120
): CampaignEventInput[] {
  if (productIds.length === 0 || groupJids.length === 0) return [];

  const products = shuffle(productIds);
  const batches: string[][] = [];

  for (let i = 0; i < products.length; i++) {
    let batch = shuffle(groupJids);
    if (i > 0) {
      const prevLast = batches[i - 1][batches[i - 1].length - 1];
      const prevFirst = batches[i - 1][0];
      let attempts = 0;
      while (
        (batch[0] === prevLast || batch[0] === prevFirst) &&
        attempts < 50 &&
        groupJids.length > 1
      ) {
        batch = shuffle(groupJids);
        attempts++;
      }
    }
    batches.push(batch);
  }

  const events: CampaignEventInput[] = [];
  const startJitter = randomInt(0, jitterSeconds);
  let current = new Date(startAt.getTime() + startJitter * 1000);
  let absoluteOrder = 0;

  for (let pIdx = 0; pIdx < products.length; pIdx++) {
    for (let gIdx = 0; gIdx < batches[pIdx].length; gIdx++) {
      if (absoluteOrder > 0) {
        const d = randomInt(delayMinSeconds, delayMaxSeconds);
        current = new Date(current.getTime() + d * 1000);
      }
      events.push({
        product_id: products[pIdx],
        group_jid: batches[pIdx][gIdx],
        batch_index: pIdx,
        send_order: gIdx,
        scheduled_at: new Date(current),
      });
      absoluteOrder++;
    }
  }

  return events;
}
