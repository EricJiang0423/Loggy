// Lanes for a commit graph. Rows come children first (git log --topo-order); each row gets the
// lane of its dot and the line segments to draw inside it, in lane units with y 0 = top,
// 0.5 = the dot, 1 = bottom.

export interface GraphRow {
  lane: number;
  segs: [number, number, number, number][];
}

export function graphLayout(commits: { sha: string; parents: string[] }[]): { rows: GraphRow[]; width: number } {
  const listed = new Set(commits.map((c) => c.sha));
  let lanes: (string | null)[] = [];
  let width = 1;
  const rows = commits.map((c) => {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
    }
    const segs: GraphRow['segs'] = [];
    before.forEach((s, i) => s === c.sha && segs.push([i, 0, lane, 0.5]));
    lanes = lanes.map((s) => (s === c.sha ? null : s));
    const [first, ...rest] = c.parents.filter((p) => listed.has(p));
    lanes[lane] = first ?? null;
    if (first) segs.push([lane, 0.5, lane, 1]);
    for (const p of rest) {
      let j = lanes.indexOf(p);
      if (j < 0) {
        j = lanes.indexOf(null);
        if (j < 0) j = lanes.length;
        lanes[j] = p;
      }
      segs.push([lane, 0.5, j, 1]);
    }
    before.forEach((s, i) => s && s !== c.sha && lanes[i] === s && segs.push([i, 0, i, 1]));
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lanes.length, lane + 1);
    return { lane, segs };
  });
  return { rows, width };
}
