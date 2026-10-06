// Result shapes of the Home Assistant tools, shared by the toolbox (which builds them) and the gate and
// worker (which read them for the Home Assistant module). Everything in them came from Home Assistant.

export interface HomeAssistantHealth {
  version?: string;
  locationName?: string;
  entities: number;
  unavailable: { count: number; entities: { entity: string; name?: string }[] };
  updates: { entity: string; name?: string; installed?: string; latest?: string }[];
  /** null when this Home Assistant doesn't expose its integration list to the token. */
  integrations: { total: number; failed: { domain?: string; title?: string; state: string; reason?: string }[] } | null;
}

export interface HomeAssistantDevice {
  id: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  area?: string;
  macs: string[];
  ips: string[];
}

export interface HomeAssistantDevices {
  total: number;
  devices: HomeAssistantDevice[];
}

export interface HomeAssistantLogGroup {
  level: string;
  logger: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  message: string;
}

export interface HomeAssistantLogs {
  /** Time span of the entries read. */
  from?: string;
  to?: string;
  /** Only the end of a very large log is read. */
  partial: boolean;
  counts: Record<string, number>;
  groups: HomeAssistantLogGroup[];
  latest: { at: string; level: string; logger: string; message: string }[];
}
