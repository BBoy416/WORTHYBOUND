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
            Give a watch, artwork, piece of jewelry, collectible or car a public passport. Seal its
            evidence in a vault, tokenize it on Solana once your identity is verified, and have
            approved professionals review it online or in person to raise its Trust Score. Buyers
            check the passport and the item before paying, and the token changes hands only through
            WorthyBound's controlled transfer. A token is not proof of authenticity: trust must be
            earned.
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
    </div>
  );
}
