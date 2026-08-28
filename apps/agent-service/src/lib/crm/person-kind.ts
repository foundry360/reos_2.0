export type PersonKind = "lead" | "contact";

export function isPersonKind(value: string): value is PersonKind {
  return value === "lead" || value === "contact";
}

export function personBasePath(kind: PersonKind): "/leads" | "/contacts" {
  return kind === "contact" ? "/contacts" : "/leads";
}

export function personSingular(kind: PersonKind): string {
  return kind === "contact" ? "contact" : "lead";
}

export function personPlural(kind: PersonKind): string {
  return kind === "contact" ? "contacts" : "leads";
}

export function personSingularTitle(kind: PersonKind): string {
  return kind === "contact" ? "Contact" : "Lead";
}

export function personPluralTitle(kind: PersonKind): string {
  return kind === "contact" ? "Contacts" : "Leads";
}
