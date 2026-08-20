/**
 * Prefixed ID generators per DESIGN.md convention: run-, evt-, agt-, dpl-,
 * tsk-, wf-, ten-, use-. Uses crypto.randomUUID() for the suffix; takes 12 chars
 * to keep IDs short but collision-safe at portal scale.
 */

export type IdPrefix =
  | "run"
  | "evt"
  | "agt"
  | "dpl"
  | "tsk"
  | "wf"
  | "ten"
  | "usr"
  | "tok"
  | "art"
  | "stp"
  | "wfv"
  | "agv"
  | "agd"
  | "agr"
  | "ars"
  | "msg"
  | "trc"
  | "ree"
  | "aud"
  | "cor"
  | "chk"
  | "inv"
  | "mdl"
  | "imp"
  | "iss"
  | "cnv"
  | "rfl"
  | "frn"
  | "llm"
  | "llt"
  | "rsm"
  | "rpt"
  | "brv"
  | "whk"
  | "intg"
  | "llc"
  | "spf"
  | "use";

export function makeId(prefix: IdPrefix): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}-${uuid.slice(0, 12)}`;
}
