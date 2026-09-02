import Link from "next/link";
import styles from "./landing.module.css";

/** Application login — existing REOS auth route */
const LOGIN_HREF = "/login";

const PLATFORM_ITEMS = [
  {
    title: "Leads",
    body: "Capture and qualify new inquiries so nothing sits idle in the pipeline.",
    icon: "leads",
  },
  {
    title: "Contacts",
    body: "Keep client and prospect records organized with the context that matters.",
    icon: "contacts",
  },
  {
    title: "Conversations",
    body: "Work SMS, email, and messaging threads from one shared workspace.",
    icon: "conversations",
  },
  {
    title: "Opportunities",
    body: "Track deals, next steps, and pipeline progress with clear ownership.",
    icon: "opportunities",
  },
  {
    title: "Marketing",
    body: "Coordinate outreach around the people and opportunities that matter most.",
    icon: "marketing",
  },
  {
    title: "Automation",
    body: "Reduce repetitive follow-up so agents spend more time on relationships.",
    icon: "automation",
  },
  {
    title: "AI assistance",
    body: "Use AI to prioritize work, draft communication, and surface useful insight.",
    icon: "ai",
  },
  {
    title: "Activity and relationship management",
    body: "See the activity that matters and keep every relationship moving forward.",
    icon: "activity",
  },
] as const;

function PlatformIcon({ name }: { name: (typeof PLATFORM_ITEMS)[number]["icon"] }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (name) {
    case "leads":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" />
        </svg>
      );
    case "contacts":
      return (
        <svg {...common}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "conversations":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "opportunities":
      return (
        <svg {...common}>
          <path d="M3 3v18h18" />
          <path d="M7 14l4-4 4 3 5-6" />
        </svg>
      );
    case "marketing":
      return (
        <svg {...common}>
          <path d="M22 12 2 2v20l20-10z" />
          <path d="M10 14l12-8" />
        </svg>
      );
    case "automation":
      return (
        <svg {...common}>
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "ai":
      return (
        <svg {...common}>
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
          <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      );
    default:
      return null;
  }
}

const FLOW_STEPS = [
  {
    step: "Step 1",
    label: "Ingestion & Normalization",
    title: "Catch Every Lead. Instantly.",
    subtitle: "Never miss a hot prospect again.",
    body: "Whether it's a Zillow lead at 2 AM or a Facebook click on Sunday, RealtorOS responds in seconds so you beat the competition every time.",
    points: [
      {
        title: "Universal Capture",
        body: "Automatically pull in Instagram DMs, Facebook Lead Ads, TikTok inquiries, and portal leads the second they arrive.",
      },
      {
        title: "Ground Operations",
        body: "Digitize door knocking and open houses with smart QR codes, pulling warm prospects right into your pipeline.",
      },
    ],
    visual: "leads" as const,
  },
  {
    step: "Step 2",
    label: "Classification & Triage",
    title: "Weed Out the Looky-Loos.",
    subtitle: "Only talk to people ready to buy or sell.",
    body: "Stop wasting time on bad leads. The system asks for their budget and timeline automatically, then sends the hot ones straight to your phone.",
    points: [
      {
        title: "The Intake Guard",
        body: "Our AI agent engages leads within 60 seconds to identify their timeline, motivation, and budget.",
      },
      {
        title: "Intent Filtering",
        body: 'Leads are automatically categorized: "Hot Opportunities" are pushed to your phone, while "Researchers" enter long-term nurture drips.',
      },
    ],
    visual: "qualify" as const,
  },
  {
    step: "Step 3",
    label: "The Logistics Bridge (Conversion)",
    title: "Appointments Booked For You.",
    subtitle: "Wake up to a full calendar.",
    body: "No more back-and-forth emails. When a lead is ready, RealtorOS shows them your calendar and locks in the meeting.",
    points: [
      {
        title: "Hands-Free Booking",
        body: "When a lead is ready, the system sends your calendar, confirms the time, and adds the Google Maps pin.",
      },
      {
        title: "The Client Briefing",
        body: 'Give leads access to "How to Buy/Sell" guides that build your authority before you even meet.',
      },
    ],
    visual: "calendar" as const,
  },
  {
    step: "Step 4",
    label: "The Audit (Transaction Management)",
    title: "Plays Nice With Your Broker.",
    subtitle: "Keep your broker happy without double data entry.",
    body: "RealtorOS plugs right into SkySlope, Dotloop, or whatever your office uses. It updates your files automatically so you stay compliant.",
    points: [
      {
        title: "API Handshakes & Webhooks",
        body: 'Our system "talks" to your specialized transaction tools to keep your records in sync automatically without manual entry.',
      },
      {
        title: "Deadline Governance",
        body: "Automated nudges remind your clients about inspections and signatures, so no deal ever falls through the cracks.",
      },
    ],
    visual: "sync" as const,
  },
  {
    step: "Step 5",
    label: "The Loop (Retention)",
    title: "Get More Referrals.",
    subtitle: "Turn past clients into your best lead source.",
    body: "After closing, the system automatically asks for reviews and sends home anniversary texts to keep you top of mind forever.",
    points: [
      {
        title: "The Review Protocol",
        body: "The system automatically asks for Google and Zillow reviews the moment you close, building your reputation hands-free.",
      },
      {
        title: "Evergreen Care",
        body: 'Automatic "Home Anniversary" texts and market updates keep you top-of-mind for years to come, turning past clients into a perpetual referral engine.',
      },
    ],
    visual: "loop" as const,
  },
] as const;

function FlowVisual({ kind }: { kind: (typeof FLOW_STEPS)[number]["visual"] }) {
  if (kind === "leads") {
    return (
      <div className={styles.flowPanel}>
        <div className={styles.flowPanelHead}>
          <span>New Opportunities</span>
          <em>Live updates</em>
        </div>
        <ul className={styles.flowLeadList}>
          <li>
            <span className={styles.flowAvatar}>D</span>
            <div>
              <strong>Danielle Reeves</strong>
              <small>Zillow · 2m ago</small>
            </div>
          </li>
          <li>
            <span className={styles.flowAvatar}>J</span>
            <div>
              <strong>Jerome Patterson</strong>
              <small>Instagram · 18m ago</small>
            </div>
          </li>
          <li>
            <span className={styles.flowAvatar}>A</span>
            <div>
              <strong>Amara Johnson</strong>
              <small>Facebook · 1h ago</small>
            </div>
          </li>
        </ul>
      </div>
    );
  }

  if (kind === "qualify") {
    return (
      <div className={styles.flowPanel}>
        <div className={styles.flowPanelHead}>
          <span>Intake Guard</span>
          <em>Active</em>
        </div>
        <p className={styles.flowQuote}>
          &quot;I&apos;m looking to buy in the next 3 months, budget $800k.&quot;
        </p>
        <p className={styles.flowBadge}>Opportunity qualified: High Intent Buyer</p>
      </div>
    );
  }

  if (kind === "calendar") {
    return (
      <div className={styles.flowPanel}>
        <div className={styles.flowPanelHead}>
          <span>Calendar View</span>
          <em>April 2026</em>
        </div>
        <p className={styles.flowAppointment}>10:00 AM — Showing: 123 Main St</p>
        <div className={styles.flowCalendarGrid} aria-hidden>
          {Array.from({ length: 30 }, (_, i) => (
            <span key={i} className={i + 1 === 14 ? styles.flowCalendarActive : undefined}>
              {i + 1}
            </span>
          ))}
        </div>
        <p className={styles.flowBadge}>10:00 AM · Appointment set</p>
        <ol className={styles.flowTimeline}>
          <li>
            <strong>Day 1 · Text</strong>
            <span>Initial follow-up delivered</span>
          </li>
          <li>
            <strong>Day 3 · Email</strong>
            <span>Market report sent</span>
          </li>
          <li>
            <strong>Day 7 · Text</strong>
            <span>Check-in touchpoint</span>
          </li>
        </ol>
      </div>
    );
  }

  if (kind === "sync") {
    return (
      <div className={styles.flowPanel}>
        <div className={styles.flowPanelHead}>
          <span>Transaction Sync</span>
          <em>Connected</em>
        </div>
        <ul className={styles.flowSyncList}>
          <li>
            <strong>SkySlope</strong>
            <span>Synced</span>
          </li>
          <li>
            <strong>Dotloop</strong>
            <span>Synced</span>
          </li>
          <li>
            <strong>Deadline nudges</strong>
            <span>Active</span>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div className={styles.flowPanel}>
      <div className={styles.flowPanelHead}>
        <span>Retention Loop</span>
        <em>Post-close</em>
      </div>
      <ul className={styles.flowSyncList}>
        <li>
          <strong>Review request</strong>
          <span>Queued</span>
        </li>
        <li>
          <strong>Home anniversary</strong>
          <span>Scheduled</span>
        </li>
        <li>
          <strong>Market update</strong>
          <span>On cadence</span>
        </li>
      </ul>
    </div>
  );
}

const AI_CAPABILITIES = [
  "Understanding customer conversations",
  "Identifying follow-up opportunities",
  "Helping prioritize work",
  "Assisting with communication",
  "Supporting workflows",
  "Generating useful content",
  "Turning customer and business activity into actionable insight",
] as const;

export default function MarketingHomePage() {
  return (
    <div className={styles.page}>
      <a href="#main" className={styles.skipLink}>
        Skip to content
      </a>

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand} aria-label="RealtorOS home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/realtoros-logo-light.png"
              alt="RealtorOS"
              className={styles.logo}
              width={160}
              height={36}
            />
          </Link>

          <nav className={styles.navDesktop} aria-label="Primary">
            <a href="#platform">Platform</a>
            <a href="#features">Features</a>
            <a href="#ai">Artificial Intelligence</a>
            <a href="#about">About</a>
          </nav>

          <div className={styles.headerActions}>
            <Link href={LOGIN_HREF} className={styles.btnPrimary}>
              Login
            </Link>
            <details className={styles.mobileMenu}>
              <summary className={styles.mobileMenuToggle} aria-label="Open menu">
                <span />
                <span />
                <span />
              </summary>
              <div className={styles.mobileMenuPanel}>
                <a href="#platform">Platform</a>
                <a href="#features">Features</a>
                <a href="#ai">Artificial Intelligence</a>
                <a href="#about">About</a>
                <Link href={LOGIN_HREF} className={styles.btnPrimary}>
                  Login
                </Link>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-heading">
          <div className={styles.heroBackdrop} aria-hidden="true">
            <div className={styles.heroBg} />
            <div className={styles.heroTexture} />
            <div className={styles.heroWash} />
          </div>
          <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <p className={styles.brandMark}>RealtorOS</p>
            <h1 id="hero-heading" className={styles.heroTitle}>
              The Operating System for Modern Real Estate
            </h1>
            <p className={styles.heroLead}>
              RealtorOS brings your leads, contacts, conversations, opportunities, marketing,
              automation, and AI-powered workflows together in one intelligent platform built for
              real estate professionals.
            </p>
            <div className={styles.heroCtas}>
              <Link href={LOGIN_HREF} className={styles.btnPrimary}>
                Login to RealtorOS
              </Link>
              <a href="#platform" className={styles.btnSecondary}>
                Explore the Platform
              </a>
            </div>
            <p className={styles.heroByline}>
              A product of <strong>Referral Partners, LLC</strong>
            </p>
          </div>

          <div className={styles.heroVisual} aria-hidden="true">
            <div className={styles.productPlane}>
              <div className={styles.productChrome}>
                <span />
                <span />
                <span />
                <strong>RealtorOS Workspace</strong>
              </div>
              <div className={styles.productGrid}>
                <div className={styles.productRail}>
                  <span className={styles.railActive}>Overview</span>
                  <span>Leads</span>
                  <span>Clients</span>
                  <span>Opportunities</span>
                  <span>Conversations</span>
                  <span>Calendar</span>
                </div>
                <div className={styles.productMain}>
                  <div className={styles.productRow}>
                    <div className={styles.productPanel}>
                      <p>Pipeline</p>
                      <div className={styles.bars}>
                        <i style={{ width: "72%" }} />
                        <i style={{ width: "54%" }} />
                        <i style={{ width: "38%" }} />
                      </div>
                    </div>
                    <div className={styles.productPanel}>
                      <p>Next actions</p>
                      <ul>
                        <li>Follow up · listing consult</li>
                        <li>Send market update</li>
                        <li>Confirm showing window</li>
                      </ul>
                    </div>
                  </div>
                  <div className={styles.productPanelWide}>
                    <p>Relationship timeline</p>
                    <div className={styles.timeline}>
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </section>

        <section id="platform" className={`${styles.sectionBand} ${styles.sectionLight}`}>
          <div className={styles.sectionBandInner}>
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>Platform</p>
            <h2>Everything Your Real Estate Business Needs. In One Place.</h2>
            <p>
              RealtorOS is built so professionals can manage the full relationship lifecycle
              without jumping between disconnected tools.
            </p>
          </div>
          <ul className={styles.platformGrid}>
            {PLATFORM_ITEMS.map((item) => (
              <li key={item.title} className={styles.platformCard}>
                <span className={styles.platformIcon} aria-hidden>
                  <PlatformIcon name={item.icon} />
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            ))}
          </ul>
          </div>
        </section>

        <section id="features" className={`${styles.sectionBand} ${styles.sectionDark} ${styles.flowSection}`}>
          <div className={styles.sectionDarkBackdrop} aria-hidden="true">
            <div className={styles.sectionDarkBg} />
            <div className={styles.sectionDarkWash} />
          </div>
          <div className={styles.sectionBandInner}>
          <div className={styles.flowIntro}>
            <p className={styles.eyebrow}>How it works</p>
            <h2>Get Leads. Qualify Them. Close Deals.</h2>
            <p>
              Stop losing deals to bad follow-up. RealtorOS is a high-performance engine that chases
              leads, asks the right questions, and books appointments for you. While you&apos;re out
              selling houses, your digital partner is working your database 24/7/365.
            </p>
            <a href="#platform" className={styles.btnPrimary}>
              Initialize Your Architecture
            </a>
          </div>

          <div className={styles.flowSteps}>
            {FLOW_STEPS.map((item, index) => (
              <article
                key={item.step}
                className={`${styles.flowStep} ${index % 2 === 1 ? styles.flowStepFlip : ""}`}
              >
                <div className={styles.flowStepCopy}>
                  <p className={styles.flowStepEyebrow}>
                    {item.step}: {item.label}
                  </p>
                  <h3>{item.title}</h3>
                  <p className={styles.flowStepSubtitle}>{item.subtitle}</p>
                  <p>{item.body}</p>
                  <div className={styles.flowPoints}>
                    {item.points.map((point) => (
                      <div key={point.title}>
                        <h4>{point.title}</h4>
                        <p>{point.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.flowStepVisual}>
                  <FlowVisual kind={item.visual} />
                </div>
              </article>
            ))}
          </div>

          <div className={styles.flowFooterCta}>
            <Link href={LOGIN_HREF} className={styles.btnPrimary}>
              Initialize Operation
            </Link>
          </div>
          </div>
        </section>

        <section id="ai" className={`${styles.sectionBand} ${styles.sectionLight}`}>
          <div className={styles.sectionBandInner}>
          <div className={styles.aiLayout}>
            <div>
              <p className={styles.eyebrow}>Artificial Intelligence</p>
              <h2>Artificial Intelligence That Works Alongside You</h2>
              <p>
                RealtorOS AI is designed to help real estate professionals work more efficiently
                without replacing the human relationship at the center of the business.
              </p>
              <p>
                Use AI where it adds leverage: clarity, prioritization, drafting support, and
                operational insight, while you stay in control of every client conversation and
                decision.
              </p>
            </div>
            <ul className={styles.aiList}>
              {AI_CAPABILITIES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          </div>
        </section>

        <section className={`${styles.sectionBand} ${styles.sectionDark}`}>
          <div className={styles.sectionDarkBackdrop} aria-hidden="true">
            <div className={styles.sectionDarkBg} />
            <div className={styles.sectionDarkWash} />
          </div>
          <div className={styles.sectionBandInner}>
          <div className={styles.whyBlock}>
            <p className={styles.eyebrow}>Why RealtorOS</p>
            <h2>Your Business Is More Than a Contact List</h2>
            <p>
              Modern real estate professionals manage information across multiple systems,
              conversations, tasks, marketing channels, and follow-ups. Context gets scattered.
              Priority gets hard to see. Relationships suffer when the operating environment is
              fragmented.
            </p>
            <p>
              RealtorOS is designed to bring those activities into one operating environment so
              professionals can spend less time managing systems and more time managing
              relationships.
            </p>
          </div>
          </div>
        </section>

        <section id="about" className={`${styles.sectionBand} ${styles.sectionLight} ${styles.companySection}`}>
          <div className={styles.sectionBandInner}>
          <div className={styles.companyIntro}>
            <h2>Mission: Professional Liberation.</h2>
            <p className={styles.companySubhead}>
              We didn&apos;t just build another app. We built the infrastructure for the modern real
              estate professional.
            </p>
          </div>

          <div className={styles.companyGrid}>
            <div className={styles.companyCopy}>
              <p>
                Referral Partners was founded by industry veterans and system engineers who realized
                that great agents were being held back by administrative friction. Our Strategic
                Co-Founders, Nikki and Jason, are leading a joint infrastructure deployment.
              </p>
              <p>
                Their objective is to secure and stabilize exactly 9 high-volume Revenue Nodes to
                achieve full maturity and full vesting of the decentralized $RP token asset. We are
                dedicated to the &quot;math&quot; of real estate, providing the high-performance
                machinery that allows agents to return to what they do best: the handshake.
              </p>
              <p className={styles.companyProductNote}>
                <strong>RealtorOS</strong> is a product of <strong>Referral Partners, LLC</strong>.
              </p>
              <a
                className={styles.companyCta}
                href="mailto:support@referralpartners.io"
              >
                Meet the Team
                <span aria-hidden>→</span>
              </a>
            </div>

            <div className={styles.companyVisual}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/marketing/company-blueprint.png"
                alt="Referral Partners infrastructure blueprint"
                width={1024}
                height={1024}
              />
            </div>
          </div>
          </div>
        </section>

        <section className={`${styles.sectionBand} ${styles.sectionDark} ${styles.ctaBand}`} aria-labelledby="cta-heading">
          <div className={styles.sectionDarkBackdrop} aria-hidden="true">
            <div className={styles.sectionDarkBg} />
            <div className={styles.sectionDarkWash} />
          </div>
          <div className={styles.sectionBandInner}>
          <h2 id="cta-heading">Ready to run your business differently?</h2>
          <p>Sign in to your RealtorOS workspace to continue.</p>
          <Link href={LOGIN_HREF} className={styles.btnPrimaryLight}>
            Login to RealtorOS
          </Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <p className={styles.footerName}>RealtorOS</p>
            <p>A product of Referral Partners, LLC</p>
            <a href="mailto:support@referralpartners.io">support@referralpartners.io</a>
          </div>
          <nav className={styles.footerNav} aria-label="Footer">
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <Link href={LOGIN_HREF}>Login</Link>
          </nav>
        </div>
        <p className={styles.copyright}>
          © 2026 Referral Partners, LLC. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
