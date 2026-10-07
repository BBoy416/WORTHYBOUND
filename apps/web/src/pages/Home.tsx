import { isWbId } from "@worthybound/shared";
import { useState, type FormEvent } from "react";
import heroMark from "../assets/logo-hero.webp";
import solanaWordmark from "../assets/solana-wordmark.svg?no-inline";
import { ErrorText } from "../components/ui.js";
import { useRouter } from "../router.js";
import { useSession } from "../session.js";

export function HomePage() {
  const { navigate } = useRouter();
  const { me } = useSession();
  const [wbId, setWbId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lookUp = (event: FormEvent) => {
    event.preventDefault();
    const id = wbId.trim().toUpperCase();
    if (!isWbId(id)) return setError("A WB ID looks like WB-7F93A281.");
    navigate(`/passport/${id}`);
  };

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">Digital identity for physical assets · Solana</p>
          <h1>
            Real assets. <span className="gold">Proven identity.</span>
          </h1>
          <p className="lead">
            Every valuable item has a story. WorthyBound gives yours a digital passport—with a
            sealed evidence vault, a Trust Score supported by evidence and verification, and an
            ownership token on Solana.
          </p>
          <p>
            <strong className="gold">Tokenize the item. Unlock its story. Earn the trust.</strong>
          </p>
          <form className="lookup" onSubmit={lookUp}>
            <input
              aria-label="WB ID"
              placeholder="Check a passport: WB-7F93A281"
              value={wbId}
              onChange={(e) => setWbId(e.target.value)}
            />
            <button type="submit">Check</button>
          </form>
          <ErrorText error={error} />
          <p className="muted tiny powered-by">
            Powered by <img src={solanaWordmark} height={14} alt="Solana" />
          </p>
          {me && (
            <p>
              <a
                className="button ghost"
                href="/assets"
                onClick={(e) => (e.preventDefault(), navigate("/assets"))}
              >
                Go to my assets
              </a>
            </p>
          )}
        </div>
        <div className="hero-mark" aria-hidden="true">
          <img src={heroMark} alt="" width={658} height={400} />
        </div>
      </section>
      <section className="steps">
        {[
          [
            "Register",
            "Describe the item. Its serial is fingerprinted so it cannot be registered twice.",
          ],
          [
            "Prove",
            "Add live camera photos, receipts and certificates. Every file is hashed, sealed and checked automatically.",
          ],
          [
            "Tokenize",
            "Once your identity is verified, the asset is minted on Solana, frozen, and moves only through WorthyBound.",
          ],
          [
            "Verify (optional)",
            "An approved professional inspects it online or in person and signs an attestation with their wallet. This raises the Trust Score.",
          ],
        ].map(([title, text], i) => (
          <div key={title} className="step">
            <span className="step-n">{i + 1}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </section>
      <section className="trust-ladder">
        <h2>Trust is earned</h2>
        <p className="muted">
          Anyone can register an item. Trust grows through submitted evidence, online reviews by
          approved verifiers, and independent in-person inspections. Two independent in-person
          inspections provide WorthyBound’s highest level of verification.
        </p>
        <div className="steps">
          {[
            ["65", "Your evidence", "Live camera photos and documents that pass automatic checks."],
            ["75–80", "Online review", "One or two approved professionals review it remotely."],
            ["85–90", "In-person inspection", "A professional examines the item itself."],
            ["100", "Two inspections", "Two independent professionals inspect it in person."],
          ].map(([max, title, text]) => (
            <div key={title} className="step">
              <span className="step-label">Trust Score up to</span>
              <span className="step-n score">{max}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <p className="muted small">
          The highest Trust Score an item can reach depends on how it was verified. Evidence
          quality, confirmed claims and open disputes set the actual score.
        </p>
        <p className="muted">
          A token alone does not prove authenticity. The evidence behind it—and the people who
          verify it—build trust.
        </p>
      </section>
      <section className="trust-ladder">
        <h2>History that stays with the item</h2>
        <p className="muted">
          Your private documents stay off-chain. Your ownership history stays connected to the item.
          The token changes hands only through WorthyBound’s verified transfer process, keeping that
          history intact as ownership changes.
        </p>
      </section>
    </div>
  );
}
