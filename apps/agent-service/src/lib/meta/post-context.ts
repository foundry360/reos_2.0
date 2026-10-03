import OpenAI from "openai";
import { getOpenAIApiKey, getOpenAIModel } from "@/lib/admin/platform-credentials";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const META_GRAPH_VERSION = "v21.0";
const CAPTION_LIMIT = 2000;

export interface PostProperty {
  address: string | null;
  city: string | null;
  price: string | null;
  beds: string | null;
  baths: string | null;
  sqft: string | null;
  status: string | null;
  openHouse: string | null;
  highlights: string | null;
}

export interface PostContext {
  caption: string | null;
  permalink: string | null;
  isListing: boolean;
  property: PostProperty | null;
  /** One line such as "123 Main St, Scottsdale · $850K · 4 bd / 3 ba". */
  propertySummary: string | null;
}

const EXTRACT_PROMPT = `You read social media posts from a real-estate business and extract the property being promoted, if any.
is_listing = true only when the post is about a specific property (for sale, for rent, just sold, open house, coming soon).
Use only facts stated in the post. Use null for anything not stated. Keep values short (e.g. "$850K", "4", "2.5", "2,100 sq ft").
status: the listing state the post announces, e.g. "Just listed", "Coming soon", "Pending", "Sold", "For rent", "Price reduced".
highlights: up to 12 words of notable features mentioned in the post, or null.`;

async function fetchPost(params: {
  platform: "facebook" | "instagram";
  postId: string;
  pageToken: string;
}): Promise<{ caption: string | null; permalink: string | null } | null> {
  const fields =
    params.platform === "facebook"
      ? "message,permalink_url,attachments{title,description}"
      : "caption,permalink";
  const query = new URLSearchParams({ fields, access_token: params.pageToken });

  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(params.postId)}?${query.toString()}`,
      { cache: "no-store" },
    );
    const data = (await response.json()) as {
      message?: string;
      caption?: string;
      permalink_url?: string;
      permalink?: string;
      attachments?: { data?: Array<{ title?: string; description?: string }> };
      error?: { message?: string };
    };
    if (!response.ok || data.error) {
      console.error("Meta post fetch failed:", data.error?.message ?? response.status);
      return null;
    }

    const attachment = data.attachments?.data?.[0];
    const parts = [
      data.message ?? data.caption,
      attachment?.title,
      attachment?.description,
    ]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));
    const caption = [...new Set(parts)].join("\n").slice(0, CAPTION_LIMIT) || null;

    return { caption, permalink: data.permalink_url ?? data.permalink ?? null };
  } catch (error) {
    console.error("Meta post fetch failed:", error);
    return null;
  }
}

function readText(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed.slice(0, 120) : null;
}

async function extractProperty(
  caption: string,
): Promise<{ isListing: boolean; property: PostProperty | null }> {
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) return { isListing: false, property: null };

  try {
    const completion = await new OpenAI({ apiKey }).chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        {
          role: "user",
          content: `Post:\n"""${caption}"""\n\nRespond with JSON: {"is_listing": boolean, "address": string|null, "city": string|null, "price": string|null, "beds": string|null, "baths": string|null, "sqft": string|null, "status": string|null, "open_house": string|null, "highlights": string|null}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { isListing: false, property: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.is_listing !== true) return { isListing: false, property: null };

    return {
      isListing: true,
      property: {
        address: readText(parsed.address),
        city: readText(parsed.city),
        price: readText(parsed.price),
        beds: readText(parsed.beds),
        baths: readText(parsed.baths),
        sqft: readText(parsed.sqft),
        status: readText(parsed.status),
        openHouse: readText(parsed.open_house),
        highlights: readText(parsed.highlights),
      },
    };
  } catch (error) {
    console.error("Post property extraction failed:", error);
    return { isListing: false, property: null };
  }
}

export function summarizeProperty(property: PostProperty): string | null {
  const place = [property.address, property.city].filter(Boolean).join(", ");
  const rooms = [
    property.beds ? `${property.beds} bd` : null,
    property.baths ? `${property.baths} ba` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  const parts = [place || null, property.price, rooms || null, property.sqft, property.status];
  const summary = parts.filter(Boolean).join(" · ");
  return summary || null;
}

/**
 * Looks up the post a comment was left on and the property it promotes.
 * Cached per post so a popular listing is only fetched and analyzed once.
 */
export async function getPostContext(params: {
  tenantId: string;
  platform: "facebook" | "instagram";
  postId: string | null;
  pageToken: string | null;
}): Promise<PostContext | null> {
  const { tenantId, platform, postId, pageToken } = params;
  if (!postId) return null;
  const db = getSupabaseAdmin();

  if (db) {
    const { data: cached } = await db
      .from("meta_posts")
      .select("caption, permalink, is_listing, property, property_summary")
      .eq("platform", platform)
      .eq("post_id", postId)
      .maybeSingle();
    if (cached) {
      return {
        caption: cached.caption,
        permalink: cached.permalink,
        isListing: cached.is_listing,
        property: (cached.property as PostProperty | null) ?? null,
        propertySummary: cached.property_summary,
      };
    }
  }

  if (!pageToken) return null;
  const post = await fetchPost({ platform, postId, pageToken });
  if (!post) return null;

  const { isListing, property } = post.caption
    ? await extractProperty(post.caption)
    : { isListing: false, property: null };
  const context: PostContext = {
    caption: post.caption,
    permalink: post.permalink,
    isListing,
    property,
    propertySummary: property ? summarizeProperty(property) : null,
  };

  if (db) {
    const { error } = await db.from("meta_posts").upsert(
      {
        tenant_id: tenantId,
        platform,
        post_id: postId,
        caption: context.caption,
        permalink: context.permalink,
        is_listing: context.isListing,
        property: context.property,
        property_summary: context.propertySummary,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "platform,post_id" },
    );
    if (error) console.error("Meta post cache write failed:", error);
  }

  return context;
}

/** Context block for the conversation agent describing the post they commented on. */
export function describePostForAgent(context: PostContext): string {
  const lines: string[] = [];
  if (context.isListing && context.property) {
    const p = context.property;
    lines.push("POST THEY COMMENTED ON (a specific property):");
    if (p.address || p.city) lines.push(`- Property: ${[p.address, p.city].filter(Boolean).join(", ")}`);
    if (p.price) lines.push(`- Price: ${p.price}`);
    if (p.beds || p.baths) {
      lines.push(`- Beds/Baths: ${[p.beds ? `${p.beds} bd` : null, p.baths ? `${p.baths} ba` : null].filter(Boolean).join(" / ")}`);
    }
    if (p.sqft) lines.push(`- Size: ${p.sqft}`);
    if (p.status) lines.push(`- Status: ${p.status}`);
    if (p.openHouse) lines.push(`- Open house: ${p.openHouse}`);
    if (p.highlights) lines.push(`- Highlights: ${p.highlights}`);
  } else {
    lines.push("POST THEY COMMENTED ON (not about a specific property):");
  }
  if (context.caption) lines.push(`- Caption: "${context.caption.slice(0, 600)}"`);
  if (context.permalink) lines.push(`- Link: ${context.permalink}`);

  lines.push(
    context.isListing
      ? "PROPERTY RULES: Assume questions like \"is this still available?\", \"how much?\" or \"can I see it?\" refer to this property, and name it in your reply. Use only facts listed above; if they ask something not listed (HOA, taxes, schools, exact availability), say the agent will confirm instead of guessing. Offer a showing or the open house when it fits."
      : "If they ask about \"this\" property and the post does not identify one, ask which home or area they mean.",
  );
  return lines.join("\n");
}
