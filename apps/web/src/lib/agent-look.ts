// How an agent looks: its mascot and glow colour. Both are optional on the agent; unset (or a mascot that
// has since left the registry) falls back to the default for its role template.
import { DEFAULT_MASCOT, isMascot, type MascotVariant } from "@/components/mascots";

const ROLE_MASCOT: Record<string, MascotVariant> = {
  "it-manager": "monitor",
  "systems-admin": "beanie",
  "network-admin": "headset",
  "security-admin": "nightshift",
  moss: "monitor",
};

const ROLE_GLOW: Record<string, string> = {
  "it-manager": "var(--phosphor)",
  "systems-admin": "var(--amber)",
  "network-admin": "var(--signal)",
  "security-admin": "#ff7ad9",
  moss: "#c39bff",
};

/** Glow colours offered in the picker (the role colours plus alarm). */
export const GLOW_CHOICES = [
  { value: "#4dff9a", label: "Phosphor" },
  { value: "#ffb547", label: "Amber" },
  { value: "#5ad8ff", label: "Signal" },
  { value: "#ff7ad9", label: "Pink" },
  { value: "#ff6b4a", label: "Alarm" },
] as const;

export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

interface AgentLook {
  mascot?: string | null;
  mascotGlow?: string | null;
  templateKey?: string | null;
}

export function roleMascot(templateKey?: string | null): MascotVariant {
  return ROLE_MASCOT[templateKey ?? ""] ?? DEFAULT_MASCOT;
}

export function agentMascot(a: AgentLook): MascotVariant {
  return isMascot(a.mascot) ? a.mascot : roleMascot(a.templateKey);
}

export function roleGlow(templateKey?: string | null): string {
  return ROLE_GLOW[templateKey ?? ""] ?? "var(--phosphor)";
}

export function agentGlow(a: AgentLook): string {
  return a.mascotGlow && HEX_COLOUR.test(a.mascotGlow) ? a.mascotGlow : roleGlow(a.templateKey);
}
