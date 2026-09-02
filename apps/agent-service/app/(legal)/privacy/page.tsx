import type { Metadata } from "next";
import { LegalMeta, LegalPageShell } from "../_components/legal-page-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Privacy Policy for REOS by Referral Partners, LLC explaining how we collect, use, and protect information, including Google user data.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPageShell title="Privacy Policy">
      <LegalMeta effectiveDate="September 2, 2026" lastUpdated="September 2, 2026" />

      <p>
        This Privacy Policy explains how <strong>Referral Partners, LLC</strong>{" "}
        (&quot;Referral Partners,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;)
        collects, accesses, uses, stores, and shares information when you use{" "}
        <strong>REOS</strong> (&quot;REOS,&quot; the &quot;Service,&quot; or the
        &quot;App&quot;).
      </p>

      <p>
        REOS is a customer relationship management and productivity platform designed for
        real estate professionals to manage contacts, leads, opportunities, communications,
        tasks, calendars, workflows, and related business activities.
      </p>

      <p>
        By using REOS, you agree to the practices described in this Privacy Policy.
      </p>

      <h2>1. Information We Collect</h2>
      <p>
        We collect information you provide directly, information generated through your use
        of REOS, and information from third-party services that you explicitly authorize us
        to connect to your REOS account.
      </p>

      <h3>Information You Provide</h3>
      <p>Depending on how you use REOS, we may collect:</p>
      <ul>
        <li>Name</li>
        <li>Email address</li>
        <li>Phone number</li>
        <li>Company, brokerage, or business information</li>
        <li>Account and authentication information</li>
        <li>Contact and lead information</li>
        <li>Customer and prospect information</li>
        <li>Opportunity and transaction-related information</li>
        <li>Tasks and notes</li>
        <li>Calendar information</li>
        <li>Email and other communications</li>
        <li>Preferences and account configuration</li>
        <li>Subscription and billing information</li>
      </ul>

      <h3>Information Automatically Collected</h3>
      <p>When you use REOS, we may automatically collect:</p>
      <ul>
        <li>IP address</li>
        <li>Browser and device information</li>
        <li>Operating system</li>
        <li>Log and usage information</li>
        <li>Pages and features accessed</li>
        <li>Dates and times of activity</li>
        <li>Diagnostic and performance information</li>
        <li>Security and authentication information</li>
      </ul>

      <h2>2. Google User Data</h2>
      <p>
        REOS may allow you to connect your Google Account to provide features such as Google
        sign-in, Gmail integration, and Google Calendar integration.
      </p>
      <p>
        <strong>
          REOS only accesses Google data after you explicitly authorize the requested
          permissions through Google&apos;s authorization process.
        </strong>
      </p>
      <p>
        Depending on the Google permissions you authorize, REOS may access the following
        types of Google user data:
      </p>

      <h3>Google Account Information</h3>
      <p>REOS may receive basic account information such as:</p>
      <ul>
        <li>Your name</li>
        <li>Email address</li>
        <li>Google account identifier</li>
        <li>Profile information made available through the permissions you authorize</li>
      </ul>
      <p>
        This information is used to create and authenticate your REOS account and associate
        your Google account with your REOS account.
      </p>

      <h3>Gmail Data</h3>
      <p>
        If you authorize Gmail access, REOS may access information necessary to provide
        email functionality, which may include:
      </p>
      <ul>
        <li>Email messages you authorize REOS to access</li>
        <li>Sender and recipient email addresses</li>
        <li>Email subject lines</li>
        <li>Email message content</li>
        <li>Email timestamps</li>
        <li>Gmail message and thread identifiers</li>
        <li>Email labels or other metadata necessary to organize and synchronize messages</li>
      </ul>
      <p>REOS uses Gmail data to provide features you request, including:</p>
      <ul>
        <li>Sending email from REOS on your behalf</li>
        <li>Synchronizing email conversations with contacts and opportunities</li>
        <li>Associating email communications with CRM records</li>
        <li>Displaying relevant email conversations within REOS</li>
        <li>Maintaining email thread and message relationships</li>
        <li>Supporting CRM activity and communication history</li>
        <li>
          Providing email-related automation or productivity features that you enable
        </li>
      </ul>
      <p>
        REOS does <strong>not</strong> use Gmail data for advertising, sell Gmail data, or
        use Gmail data to create advertising profiles.
      </p>

      <h3>Google Calendar Data</h3>
      <p>
        If you authorize Google Calendar access, REOS may access information necessary to
        provide calendar functionality, including:
      </p>
      <ul>
        <li>Calendar event titles</li>
        <li>Event dates and times</li>
        <li>Event descriptions</li>
        <li>Event locations</li>
        <li>Attendee information</li>
        <li>Calendar identifiers</li>
        <li>Event identifiers</li>
        <li>Other calendar metadata necessary to provide the requested functionality</li>
      </ul>
      <p>REOS uses Google Calendar data to:</p>
      <ul>
        <li>Display relevant calendar events within REOS</li>
        <li>Create, update, or manage calendar events when you request those actions</li>
        <li>Associate appointments with CRM contacts or opportunities</li>
        <li>Support scheduling and productivity features</li>
        <li>Trigger workflows or reminders that you explicitly enable</li>
      </ul>
      <p>REOS does not use Google Calendar data for advertising.</p>

      <h2>3. How We Use Information</h2>
      <p>We use information collected through REOS to:</p>
      <ul>
        <li>Provide and operate the Service</li>
        <li>Authenticate users and maintain accounts</li>
        <li>Manage contacts, leads, and opportunities</li>
        <li>Provide email and messaging functionality</li>
        <li>Synchronize authorized third-party services</li>
        <li>Provide calendar and scheduling functionality</li>
        <li>Provide tasks, workflows, and automation</li>
        <li>Associate communications and activities with CRM records</li>
        <li>Provide AI-powered features that you choose to use</li>
        <li>Provide customer support</li>
        <li>Maintain and improve the Service</li>
        <li>Detect and prevent fraud, abuse, and security incidents</li>
        <li>Process subscriptions and payments</li>
        <li>Comply with applicable legal obligations</li>
      </ul>
      <p>
        We only use Google user data for purposes that are necessary to provide or improve
        the user-facing features of REOS that you have requested or authorized.
      </p>

      <h2>4. Artificial Intelligence</h2>
      <p>
        REOS may provide artificial intelligence features such as content generation,
        recommendations, classification, workflow automation, communication assistance, or
        other productivity functionality.
      </p>
      <p>
        When you use an AI-powered feature, information necessary to provide that feature
        may be processed by REOS and, where applicable, by third-party AI service providers
        acting on our behalf.
      </p>
      <p>
        Google user data obtained through Google APIs is{" "}
        <strong>
          not used to train generalized or non-personalized artificial intelligence or
          machine learning models
        </strong>
        .
      </p>
      <p>
        AI-generated content may contain errors or omissions. You are responsible for
        reviewing AI-generated content before sending communications, making business
        decisions, or taking other actions based on that content.
      </p>

      <h2>5. How We Share Information</h2>
      <p>
        <strong>We do not sell your personal information or Google user data.</strong>
      </p>
      <p>
        We may share information with service providers that process information on our
        behalf and help us operate REOS.
      </p>
      <p>These providers may include companies providing:</p>
      <ul>
        <li>Cloud hosting and infrastructure</li>
        <li>Database and data storage</li>
        <li>Authentication</li>
        <li>Email and communications</li>
        <li>Artificial intelligence services</li>
        <li>Analytics and monitoring</li>
        <li>Customer support</li>
        <li>Payment processing</li>
        <li>Security and fraud prevention</li>
      </ul>
      <p>
        Service providers are permitted to access information only as necessary to provide
        services to us or to operate features requested by you.
      </p>

      <h3>Google User Data</h3>
      <p>
        We do not transfer, sell, or disclose Google user data to third parties except as
        necessary to:
      </p>
      <ol>
        <li>
          Provide or improve REOS features that you have requested or authorized;
        </li>
        <li>
          Process information through service providers acting on our behalf to provide
          those features;
        </li>
        <li>
          Comply with applicable law, regulation, legal process, or governmental request; or
        </li>
        <li>
          Protect the security, integrity, and operation of REOS and its users.
        </li>
      </ol>
      <p>
        REOS does not use Google user data for targeted advertising, personalized
        advertising, or advertising profiling.
      </p>
      <p>
        Our handling of information received from Google APIs complies with the{" "}
        <strong>
          Google API Services User Data Policy and its Limited Use requirements
        </strong>
        .
      </p>

      <h2>6. Data Storage and Security</h2>
      <p>
        Information collected by REOS may be stored on servers and infrastructure operated
        by Referral Partners or our authorized service providers.
      </p>
      <p>
        We use reasonable administrative, technical, and organizational safeguards designed
        to protect personal information and Google user data from unauthorized access, use,
        alteration, disclosure, or destruction.
      </p>
      <p>These safeguards may include:</p>
      <ul>
        <li>Encryption of data during transmission</li>
        <li>Secure authentication mechanisms</li>
        <li>Access controls</li>
        <li>Role-based permissions where applicable</li>
        <li>Secure storage practices</li>
        <li>Monitoring and logging</li>
        <li>
          Security measures designed to protect connected third-party credentials and
          authorization tokens
        </li>
      </ul>
      <p>
        OAuth credentials and authorization tokens are stored and handled using security
        practices designed to prevent unauthorized access.
      </p>
      <p>
        No method of electronic transmission or storage is completely secure, and we cannot
        guarantee absolute security.
      </p>

      <h2>7. Data Retention</h2>
      <p>
        We retain information for as long as reasonably necessary to provide REOS, maintain
        your account, provide features you have requested, comply with legal obligations,
        resolve disputes, enforce agreements, and maintain security.
      </p>
      <p>
        Google user data obtained through an authorized integration is retained only as
        reasonably necessary to provide the functionality for which you authorized access.
      </p>
      <p>
        If you disconnect a Google account, REOS will stop accessing new Google data through
        that authorization. Information previously synchronized into REOS may remain in your
        REOS account until you delete it or request deletion, subject to applicable legal,
        security, backup, and operational requirements.
      </p>

      <h2>8. Data Deletion</h2>
      <p>
        You may request deletion of personal information associated with your REOS account
        by contacting:
      </p>
      <p>
        <strong>
          <a href="mailto:support@referralpartners.io">support@referralpartners.io</a>
        </strong>
      </p>
      <p>
        You may also disconnect authorized third-party integrations through available REOS
        account controls.
      </p>
      <p>
        When you request deletion, we will take reasonable steps to delete applicable
        information, subject to information that we are required or permitted to retain for
        legal, security, fraud prevention, accounting, dispute resolution, or legitimate
        operational purposes.
      </p>
      <p>
        Backups may retain deleted information for a limited period before being overwritten
        or securely deleted.
      </p>

      <h2>9. Third-Party Services</h2>
      <p>
        REOS may integrate with third-party services including Google, Microsoft, Meta,
        payment providers, authentication providers, communication platforms, and other
        services.
      </p>
      <p>
        When you connect a third-party service, you authorize REOS to access the information
        necessary to provide the functionality you have selected.
      </p>
      <p>
        Third-party services have their own terms and privacy policies. Your use of those
        services is also subject to their respective policies.
      </p>
      <p>
        You can revoke authorization for Google services through your Google Account
        settings or by disconnecting the integration through REOS where that functionality
        is available.
      </p>

      <h2>10. Your Responsibilities</h2>
      <p>
        You are responsible for ensuring that you have the appropriate rights and
        permissions to collect, use, and process information that you enter into REOS.
      </p>
      <p>
        You should not use REOS to store or process information that you are prohibited from
        collecting or processing under applicable law or contractual obligations.
      </p>
      <p>
        You are also responsible for ensuring that communications sent through REOS comply
        with applicable laws and regulations, including applicable requirements relating to
        electronic communications, marketing, privacy, and consumer protection.
      </p>

      <h2>11. Your Privacy Rights</h2>
      <p>
        Depending on where you live, you may have rights regarding your personal
        information, including the right to:
      </p>
      <ul>
        <li>Access personal information we maintain about you</li>
        <li>Request correction of inaccurate information</li>
        <li>Request deletion of certain information</li>
        <li>Request restriction of certain processing</li>
        <li>Object to certain processing</li>
        <li>Request portability of certain information</li>
        <li>Withdraw consent where processing is based on consent</li>
      </ul>
      <p>
        To exercise applicable rights, contact us at{" "}
        <strong>
          <a href="mailto:support@referralpartners.io">support@referralpartners.io</a>
        </strong>
        .
      </p>

      <h2>12. Children&apos;s Privacy</h2>
      <p>
        REOS is intended for business and professional use and is not directed to children
        under 13.
      </p>
      <p>We do not knowingly collect personal information from children under 13.</p>

      <h2>13. International Data Transfers</h2>
      <p>
        REOS and its service providers may process or store information in countries other
        than the country in which you reside.
      </p>
      <p>
        Where required, we use appropriate safeguards for international transfers of
        personal information.
      </p>

      <h2>14. Changes to This Privacy Policy</h2>
      <p>We may update this Privacy Policy from time to time.</p>
      <p>
        If we make material changes to how we collect, use, store, or share personal
        information or Google user data, we may provide notice through REOS, by email, or
        through another appropriate method.
      </p>
      <p>
        The &quot;Last Updated&quot; date at the top of this policy indicates when it was
        most recently revised.
      </p>

      <h2>15. Contact Us</h2>
      <p>
        If you have questions about this Privacy Policy, our data practices, or your
        personal information, contact:
      </p>
      <p>
        <strong>Referral Partners, LLC</strong>
        <br />
        <strong>Email:</strong>{" "}
        <a href="mailto:support@referralpartners.io">support@referralpartners.io</a>
      </p>
      <p>
        <strong>Google API Data Disclosure:</strong>
        <br />
        REOS&apos;s use of information received from Google APIs will adhere to the{" "}
        <strong>Google API Services User Data Policy</strong>, including its{" "}
        <strong>Limited Use requirements</strong>.
      </p>
    </LegalPageShell>
  );
}
