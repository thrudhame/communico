// Delivery policy is separate from permission to read state. Ordinary tokens
// retain their stateless snapshot-delta contract; issued sliding positions own
// their per-room selection and member coverage. Neither inherits stripped hints.
import { theApp } from '#engine/app.ts';
import type { Room } from '#engine/room/index.ts';
import { filterEvents, type RoomFilter } from '#engine/tenant/filters.ts';
import { admitState, type StateAdmission } from './state-admission.ts';
import type { StateRow } from './read.ts';

type Json = Record<string, unknown>;
type Selectors = [string, string][];
type Coverage = { required: Selectors; members: Record<string, string> };
type Baseline =
  | { form: 'none' }
  | { form: 'stripped'; roomId: string; cut: number }
  | { form: 'full'; roomId: string; cut: number; coverage: Coverage };
type Source =
  | { protocol: 'ordinary'; since: number | null; fullState: boolean }
  | {
    protocol: 'sliding';
    previous?: {
      cut: number;
      membership: string;
      config: { requiredState: Selectors };
      members: Record<string, string>;
    };
  };
const keyOf = (row: StateRow) => row.type + '\0' + row.stateKey;
const emptyCoverage = (): Coverage => ({ required: [], members: {} });
function explicit(required: Selectors, userId: string, row: StateRow) {
  // Match deployed Synapse's wildcard event-type behavior.
  return required.some(([type, key]) =>
    type === '*' || (type === row.type &&
      (key === '*' || (key === '$ME' ? userId : key) === row.stateKey))
  );
}

// Rows and their successor coverage travel together. Rendering is not a delivery
// side effect: the caller publishes this result only with its successful response.
function preparedState(
  rows: StateRow[],
  coverage: Coverage = emptyCoverage(),
  userId = '',
) {
  return {
    rows,
    rendered(events: Json[]): Coverage {
      const ids = new Set(events.map((event) => event.event_id));
      const members = { ...coverage.members };
      for (const row of rows) {
        if (row.type === 'm.room.member' && ids.has(row.eventId)) {
          members[row.stateKey] = row.eventId;
        }
      }
      const missing = rows.filter((row) => !ids.has(row.eventId));
      return {
        members,
        required: coverage.required.filter((selector) =>
          !missing.some((row) => explicit([selector], userId, row))
        ),
      };
    },
  };
}

export class StateDelivery {
  private constructor(
    readonly roomId: string,
    readonly userId: string,
    readonly reason:
      | 'initial'
      | 'requested'
      | 'stripped'
      | 'nonjoined'
      | 'interrupted'
      | 'continuous',
    private before: Map<string, string>,
    private coverage: Coverage,
    readonly participationReset = false,
  ) {}

  get reset() {
    return this.reason !== 'continuous';
  }

  static async capture(
    room: Room,
    userId: string,
    source: Source,
    end: number,
  ) {
    let baseline: Baseline;
    let reason: StateDelivery['reason'] = 'continuous';
    if (source.protocol === 'ordinary') {
      baseline = source.since === null ? { form: 'none' } : {
        form: 'full',
        roomId: room.id,
        cut: source.since,
        coverage: emptyCoverage(),
      };
      reason = 'initial';
    } else {
      const previous = source.previous;
      baseline = previous === undefined
        ? { form: 'none' }
        : ['invite', 'knock'].includes(previous.membership)
        ? { form: 'stripped', roomId: room.id, cut: previous.cut }
        : {
          form: 'full',
          roomId: room.id,
          cut: previous.cut,
          coverage: {
            required: previous.config.requiredState,
            members: previous.members,
          },
        };
      reason = baseline.form === 'stripped' ? 'stripped' : 'initial';
    }
    let before: StateRow[] = [];
    let coverage = emptyCoverage();
    if (baseline.form === 'full') {
      // Translate the baseline and payload cuts together. In particular, never
      // substitute a new stay's imported opening for the old global since cut.
      const cuts = await theApp().server.query(
        'SELECT seq,pos,stay FROM feed WHERE room=? AND seq IN ((SELECT MAX(seq) FROM feed WHERE room=? AND seq<=?), (SELECT MAX(seq) FROM feed WHERE room=? AND seq<=?)) ORDER BY seq',
        [room.id, room.id, baseline.cut, room.id, end],
      );
      const a = cuts.find((row) => Number(row.seq) <= baseline.cut);
      const b = cuts.at(-1);
      reason = await room.tx(async (tx): Promise<StateDelivery['reason']> => {
        if (!a || !b) return 'nonjoined';
        if (source.protocol === 'sliding' && baseline.cut === end) {
          return 'continuous';
        }
        const group = await tx.state.publishedAt(Number(a.stay), Number(a.pos));
        const member = group === null
          ? null
          : await tx.state.groupKey(group, 'm.room.member', userId);
        const event = member === null ? null : await tx.events.get(member);
        if (
          event === null || JSON.parse(event.pdu).content?.membership !== 'join'
        ) return 'nonjoined';
        if (Number(a.stay) !== Number(b.stay)) return 'interrupted';
        // The final departure closes an interval; it does not itself prove a
        // *new* participation interval. Earlier departures/missing membership do.
        const target = await tx.state.publishedAt(
          Number(b.stay),
          Number(b.pos),
        );
        const targetId = target === null
          ? null
          : await tx.state.groupKey(target, 'm.room.member', userId);
        const targetEvent = targetId === null
          ? null
          : await tx.events.get(targetId);
        const joined = targetEvent !== null &&
          JSON.parse(targetEvent.pdu).content?.membership === 'join';
        return await tx.state.membershipInterrupted(
            userId,
            Number(a.pos),
            Number(b.pos) - (joined ? 0 : 1),
          )
          ? 'interrupted'
          : 'continuous';
      });
      if (
        reason === 'continuous' &&
        !(source.protocol === 'ordinary' && source.fullState)
      ) {
        before = (await admitState(room, {
          userId,
          ceiling: baseline.cut,
          point: { seq: baseline.cut },
        })).rows;
        coverage = baseline.coverage;
      }
    }
    return new StateDelivery(
      room.id,
      userId,
      source.protocol === 'ordinary' && source.fullState ? 'requested' : reason,
      new Map(before.map((row) => [keyOf(row), row.eventId])),
      coverage,
      ['nonjoined', 'interrupted', 'stripped'].includes(reason),
    );
  }

  private check(admission: StateAdmission) {
    if (admission.roomId !== this.roomId || admission.userId !== this.userId) {
      throw new Error('state delivery grant scope mismatch');
    }
  }

  ordinary(admission: StateAdmission, input: {
    timeline: Json[];
    limited: boolean;
    filter: RoomFilter;
    stateAfter: boolean;
    incremental: boolean;
    fullState: boolean;
  }) {
    this.check(admission);
    const rows = admission.rows;
    const inTimeline = new Set(input.timeline.map((event) => event.event_id));
    let selected = rows.filter((row) =>
      this.reset ||
      (this.before.get(keyOf(row)) !== row.eventId &&
        (input.stateAfter || !inTimeline.has(row.eventId)))
    );
    if (
      input.filter.state.lazy_load_members ||
      input.filter.timeline.lazy_load_members
    ) {
      const senders = new Set(
        input.timeline.map((event) => String(event.sender)),
      );
      const mandatoryOwn = this.reset ||
        rows.some((row) =>
          row.type === 'm.room.member' && row.stateKey === this.userId &&
          row.content.membership === 'join' &&
          this.before.get(keyOf(row)) !== row.eventId
        );
      const selectedIds = new Set(selected.map((row) => row.eventId));
      selected = rows.filter((row) =>
        row.type !== 'm.room.member'
          ? selectedIds.has(row.eventId)
          : senders.has(row.stateKey) ||
            (mandatoryOwn && row.stateKey === this.userId) ||
            ((input.limited || (input.stateAfter && !input.fullState)) &&
              input.incremental && this.before.get(keyOf(row)) !== row.eventId)
      );
    }
    return preparedState(
      filterEvents(selected, input.filter.state, this.roomId),
    );
  }

  required(admission: StateAdmission, input: {
    required: Selectors;
    timeline: Json[];
    limited: boolean;
  }) {
    this.check(admission);
    return this.selectRequired(admission.rows, input);
  }

  // Saved OOB departures are real full membership events, not room snapshots.
  // They share selection/coverage policy without acquiring a private grant.
  static departure(roomId: string, userId: string, row: StateRow, source: {
    previous?: {
      members: Record<string, string>;
      config: { requiredState: Selectors };
    };
    required: Selectors;
  }) {
    const coverage = source.previous === undefined ? emptyCoverage() : {
      members: source.previous.members,
      required: source.previous.config.requiredState,
    };
    const before = new Map<string, string>();
    const own = coverage.members[userId];
    if (own !== undefined) before.set('m.room.member\0' + userId, own);
    return new StateDelivery(
      roomId,
      userId,
      source.previous === undefined ? 'initial' : 'continuous',
      before,
      coverage,
    )
      .selectRequired([row], {
        required: source.required,
        timeline: [],
        limited: false,
      });
  }

  private selectRequired(available: StateRow[], input: {
    required: Selectors;
    timeline: Json[];
    limited: boolean;
  }) {
    const lazy = input.required.some(([t, k]) =>
      t === 'm.room.member' && k === '$LAZY'
    );
    const relevant = new Set<string>();
    for (const event of input.timeline) {
      relevant.add(String(event.sender));
      if (event.type === 'm.room.member') relevant.add(String(event.state_key));
    }
    const members = { ...this.coverage.members };
    const rows = available.filter((row) => {
      const changed = this.before.get(keyOf(row)) !== row.eventId;
      const selected = explicit(input.required, this.userId, row);
      const added = !explicit(this.coverage.required, this.userId, row);
      const lazySelected = lazy && row.type === 'm.room.member' &&
        (relevant.has(row.stateKey) ||
          (!this.reset && !input.limited && changed));
      const wanted = (selected && (this.reset || changed || added)) ||
        lazySelected;
      if (row.type === 'm.room.member') {
        const sent = members[row.stateKey] === row.eventId;
        if (changed) delete members[row.stateKey];
        if (!wanted || (sent && !this.reset)) return false;
      }
      return wanted;
    });
    return preparedState(
      rows,
      { required: input.required, members },
      this.userId,
    );
  }
}
