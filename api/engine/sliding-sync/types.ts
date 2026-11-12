// Deployed MSC4186 dialect shared by validation, selection and rendering.
export type RequiredState = [string, string][];
export type RoomConfig = {
  requiredState: RequiredState;
  timelineLimit: number;
};
export type ListFilters = {
  is_dm?: boolean;
  is_encrypted?: boolean;
  is_invite?: boolean;
  spaces?: string[];
  room_types?: (string | null)[];
  not_room_types?: (string | null)[];
  tags?: string[];
  not_tags?: string[];
  room_name_like?: string;
};
export type ListConfig = RoomConfig & {
  ranges: [number, number][] | null;
  allRooms: boolean;
  filters: ListFilters;
};
export type RoomExtension = {
  enabled: boolean;
  lists: string[];
  rooms: string[];
};
export type Extensions = {
  e2ee?: { enabled: boolean };
  to_device?: { enabled: boolean; limit: number; since: string | null };
  account_data?: RoomExtension;
  receipts?: RoomExtension;
  typing?: RoomExtension;
};
export type SlidingRequest = {
  connId: string;
  pos: string | null;
  timeoutMs: number;
  setPresence?: string;
  lists: Record<string, ListConfig>;
  subscriptions: Record<string, RoomConfig>;
  extensions: Extensions;
};
