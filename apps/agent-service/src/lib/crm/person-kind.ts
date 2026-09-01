export type PersonKind = "lead" | "contact";

export function isPersonKind(value: string): value is PersonKind {
  return value === "lead" || value === "contact";
}

export function personBasePath(kind: PersonKind): "/leads" | "/contacts" {
  return kind === "contact" ? "/contacts" : "/leads";
}

/** API path segment (`/api/leads`, `/api/contacts`) — not the UI label. */
export function personApiResource(kind: PersonKind): "leads" | "contacts" {
  return kind === "contact" ? "contacts" : "leads";
}

export function personSingular(kind: PersonKind): string {
  return kind === "contact" ? "client" : "lead";
}

export function personPlural(kind: PersonKind): string {
  return kind === "contact" ? "clients" : "leads";
}

export function personSingularTitle(kind: PersonKind): string {
  return kind === "contact" ? "Client" : "Lead";
}

export function personPluralTitle(kind: PersonKind): string {
  return kind === "contact" ? "Clients" : "Leads";
}

export function personTypeFieldLabel(kind: PersonKind): string {
  return kind === "contact" ? "Client type" : "Status";
}
