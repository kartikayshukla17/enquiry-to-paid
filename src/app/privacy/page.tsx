export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 px-5 py-10">
      <h1 className="painted font-display text-[clamp(1.7rem,4.4vw,2.3rem)] leading-[0.95] uppercase tracking-[-0.02em]">Privacy policy</h1>
      <section className="panel flex flex-col gap-4 p-5 text-ink text-sm leading-relaxed">
        <p>
          This site (<span className="nums">enquiry-to-paid.vercel.app</span>) is a demonstration and testing project built by
          Kartikay Shukla. It is not a commercial service. Every business name, rate card, and quote shown anywhere on this site
          or sent through its WhatsApp number is fictional test data — nothing here represents a real business.
        </p>

        <h2 className="font-display text-lg uppercase">What this app collects</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Sign-in:</strong> if you sign in with Google, we receive your name, email address, and profile picture from Google, used only to create your own isolated account on this site.</li>
          <li><strong>WhatsApp messages:</strong> if you message this app&apos;s WhatsApp test number, we receive your phone number and the text of your message, used only to generate a fictional test quote in reply. Your phone number is hashed before storage and never shown in full anywhere in this app.</li>
          <li><strong>Test payments:</strong> payment details (card numbers, etc.) are entered directly on Stripe&apos;s or Razorpay&apos;s own checkout pages and never pass through this app&apos;s servers. We only store the payment provider&apos;s own reference ids and status.</li>
        </ul>

        <h2 className="font-display text-lg uppercase">What we don&apos;t do</h2>
        <p>We don&apos;t sell or share your data with third parties, and we don&apos;t use it for advertising. Data from this demo exists only to make the demo work.</p>

        <h2 className="font-display text-lg uppercase">Deletion</h2>
        <p>
          To have your data deleted from this demo, email <a className="underline" href="mailto:kartikayshukla57@gmail.com">kartikayshukla57@gmail.com</a>.
        </p>

        <p className="text-xs text-ink/70">Last updated 2026-11-14.</p>
      </section>
    </main>
  );
}
