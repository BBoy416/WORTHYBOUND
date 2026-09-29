import { isWbId } from "@worthybound/shared";
import { useState, type FormEvent } from "react";
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
        <p className="eyebrow">Digital identity for physical assets · Solana</p>
        <h1>
          Real assets. <span className="gold">Proven identity.</span>
        </h1>
        <p className="lead">
          Give a watch, artwork or collectible a passport: evidence in a sealed vault, verification
          by approved professionals, and a non-transferable token on Solana. Anyone can tokenize an
          asset. Trust must be earned.
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
      </section>
      <section className="steps">
        {[
          [
            "Register",
            "Describe the item. Its serial is fingerprinted so it cannot be registered twice.",
          ],
          ["Prove", "Add photos, receipts and certificates. Every file is hashed and sealed."],
          [
            "Verify",
            "An approved professional inspects it and signs an attestation with their wallet.",
          ],
          [
            "Tokenize",
            "The asset is minted on Solana, frozen, and moves only through WorthyBound.",
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
