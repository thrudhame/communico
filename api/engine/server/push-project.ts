// Prepare immutable push input outside the server transaction. Room context
// is one snapshot; each tenant's rules, ignore list and revisions share a tx.
import { canSeeEventAt } from '#engine/client/visibility.ts';
import type { Room } from '#engine/room/index.ts';
import type { Store } from '#engine/store/index.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { rulesetAt } from '#engine/tenant/pushrules.ts';
import { type Decision, evaluate } from '#engine/push/evaluate.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import {
  parsePowerLevels,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import type { Pdu } from '#engine/pdu.ts';

export type PublicationDecision = {
  tenant: string;
  user: string;
  ruleRevision: number;
  ignoreRevision: number;
  decision: Decision | null;
};
export type PushPublication = {
  sender: string;
  decisions: PublicationDecision[];
};

export async function preparePush(
  room: Room,
  store: Store,
  eventId: string,
  stay: number,
  pos: number,
  localServers: string[],
): Promise<PushPublication> {
  const context = await room.tx(async (tx) => {
    const group = await tx.state.publishedAt(stay, pos);
    const row = await tx.events.get(eventId);
    if (row === null || group === null) {
      throw new Error('push publication lacks room context');
    }
    const event = {
      ...JSON.parse(row.pdu),
      event_id: eventId,
      room_id: room.id,
    } as Pdu;
    const live = await tx.state.groupMap(group);
    const pduAt = async (id: string | undefined) => {
      const r = id === undefined ? null : await tx.events.get(id);
      return r === null ? null : JSON.parse(r.pdu) as Pdu;
    };
    const members = [];
    for (const [key, id] of live) {
      if (!key.startsWith('m.room.member\0')) continue;
      const pdu = await pduAt(id);
      const user = key.slice('m.room.member\0'.length);
      members.push({ user, content: pdu?.content ?? {} });
    }
    const refs = await tx.state.eventReadState(eventId);
    const at = refs === null
      ? new Map<string, string>()
      : await tx.state.groupMap(refs.before.group);
    // The create event has an empty before-state; it supplies its own version.
    const create = event.type === 'm.room.create'
      ? event
      : await pduAt(at.get('m.room.create\0'));
    if (create === null) throw new Error('push publication lacks create event');
    const spec = getRulebook(create.content.room_version ?? '1').spec;
    const power = await pduAt(at.get('m.room.power_levels\0'));
    const parsed = parsePowerLevels(power?.content, spec);
    const recipients = [];
    for (const member of members) {
      if (member.user === event.sender) continue;
      const domain = member.user.slice(member.user.indexOf(':') + 1);
      if (!localServers.includes(domain)) continue;
      const invited = event.type === 'm.room.member' &&
        event.state_key === member.user &&
        event.content.membership === 'invite';
      if (member.content.membership !== 'join' && !invited) continue;
      if (!await canSeeEventAt(member.user, tx, eventId, group)) continue;
      recipients.push({
        tenant: domain,
        user: member.user,
        displayName: typeof member.content.displayname === 'string'
          ? member.content.displayname
          : null,
      });
    }
    return {
      event,
      recipients,
      joinedCount: members.filter((m) =>
        m.content.membership === 'join'
      ).length,
      senderPower: userPowerLevel(event.sender, power, create, spec),
      notificationPower: parsed.ok ? parsed.pl.notifications : {},
    };
  });
  const decisions: PublicationDecision[] = [];
  for (const name of localServers) {
    const recipients = context.recipients.filter((r) => r.tenant === name);
    if (!recipients.length) continue;
    const tenant = await openTenant(store, name);
    decisions.push(
      ...await tenant.tx(async (tx) => {
        const out: PublicationDecision[] = [];
        for (const recipient of recipients) {
          const lp = localpartOf(recipient.user);
          const account = await tx.users.byLocalpart(lp);
          if (account === null || account.deactivated) continue;
          const ignored = await tx.accountData.snapshot(
            lp,
            '',
            'm.ignored_user_list',
          );
          const value = ignored?.content as {
            ignored_users?: Record<string, unknown>;
          } | undefined;
          const list = value?.ignored_users ?? {};
          const rules = await rulesetAt(tx, lp, name);
          out.push({
            tenant: name,
            user: recipient.user,
            ruleRevision: await tx.pushRules.streamSeq(lp),
            ignoreRevision: ignored?.seq ?? 0,
            decision: Object.hasOwn(list, context.event.sender)
              ? null
              : evaluate(rules, {
                ...context,
                event: { ...context.event },
                userId: recipient.user,
                displayName: recipient.displayName,
              }),
          });
        }
        return out;
      }),
    );
  }
  return { sender: context.event.sender, decisions };
}
