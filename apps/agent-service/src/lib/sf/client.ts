import { getEnv, isSalesforceConfigured } from "@/lib/env";
import type { ContactContext, LeadStatus } from "@/lib/coordinator";

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!isSalesforceConfigured()) return null;

  const env = getEnv();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const url = `${env.SF_INSTANCE_URL}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.SF_CLIENT_ID!,
    client_secret: env.SF_CLIENT_SECRET!,
    refresh_token: env.SF_REFRESH_TOKEN!,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    console.error("Salesforce token error:", await res.text());
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    issued_at?: string;
  };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + 3600 * 1000,
  };

  return data.access_token;
}

async function sfFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const env = getEnv();
  const token = await getAccessToken();
  if (!token || !env.SF_INSTANCE_URL) return null;

  return fetch(`${env.SF_INSTANCE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

/** Find contact by phone (E.164 or digits). Returns stub context if SF not configured. */
export async function findContactByPhone(
  phone: string,
  tenantAccountId?: string,
): Promise<ContactContext> {
  const normalized = phone.replace(/\D/g, "");
  const stub: ContactContext = {
    phone,
    accountId: tenantAccountId ?? "default-tenant",
    leadStatus: "Qualifying",
    optedOut: false,
  };

  const token = await getAccessToken();
  if (!token) return stub;

  const soql = encodeURIComponent(
    `SELECT Id, AccountId, FirstName, AI_Summary__c, Lead_Status__c, Opted_Out__c FROM Contact WHERE Phone LIKE '%${normalized.slice(-10)}' LIMIT 1`,
  );

  const res = await sfFetch(`/services/data/v62.0/query?q=${soql}`);
  if (!res?.ok) return stub;

  const data = (await res.json()) as {
    records: Array<{
      Id: string;
      AccountId?: string;
      FirstName?: string;
      AI_Summary__c?: string;
      Lead_Status__c?: string;
      Opted_Out__c?: boolean;
    }>;
  };

  const record = data.records[0];
  if (!record) return stub;

  return {
    contactId: record.Id,
    accountId: record.AccountId ?? tenantAccountId,
    phone,
    firstName: record.FirstName,
    leadStatus: (record.Lead_Status__c as LeadStatus) ?? "Qualifying",
    optedOut: Boolean(record.Opted_Out__c),
    aiSummary: record.AI_Summary__c,
  };
}

export async function updateContactFields(
  contactId: string,
  fields: Record<string, string | number | boolean>,
): Promise<boolean> {
  const res = await sfFetch(`/services/data/v62.0/sobjects/Contact/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  return res !== null && res.ok;
}
