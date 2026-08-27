export function normalizePhoneToE164(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;

  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  if (digits.length >= 8 && digits.length <= 15 && /^[1-9]/.test(digits)) {
    return `+${digits}`;
  }

  return null;
}

export type PhoneParseResult =
  | { ok: true; phone: string | null }
  | { ok: false; error: string };

export function parsePhoneForStorage(phone: string | null | undefined): PhoneParseResult {
  if (!phone?.trim()) return { ok: true, phone: null };

  const normalized = normalizePhoneToE164(phone);
  if (normalized) return { ok: true, phone: normalized };

  const digits = phone.replace(/\D/g, "");
  if (digits.length > 0) {
    return { ok: false, error: "Enter a valid 10-digit phone number." };
  }

  return { ok: true, phone: null };
}

function nationalDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits.slice(0, 10);
}

export function phoneInputFromStored(phone: string | null | undefined): string {
  if (!phone?.trim()) return "";
  return formatPhoneInput(nationalDigits(phone));
}

export function formatPhoneInput(value: string): string {
  const digits = nationalDigits(value);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function formatPhoneDisplay(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;

  const digits = phone.replace(/\D/g, "");
  let national = digits;

  if (digits.length === 11 && digits.startsWith("1")) {
    national = digits.slice(1);
  }

  if (national.length !== 10) {
    return phone.trim();
  }

  return `+1-${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

export function phoneTelHref(phone: string | null | undefined): string | undefined {
  if (!phone?.trim()) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return undefined;
  return `tel:+${digits}`;
}
