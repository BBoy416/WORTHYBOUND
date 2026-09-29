import { get } from "../api.js";
import { Badge, Card, Loading, useLoad } from "../components/ui.js";
import { humanize } from "../format.js";
import { Link } from "../router.js";
import type { OwnerAsset } from "../types.js";

export function AssetsPage() {
  const { data, error } = useLoad(() => get<{ items: OwnerAsset[] }>("/assets"), []);
  return (
    <div>
      <div className="page-head">
        <h1>My assets</h1>
        <Link to="/assets/new" className="button">
          Register an asset
        </Link>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : data.items.length === 0 ? (
        <Card>
          <p className="muted">No assets yet. Register your first item to start its passport.</p>
        </Card>
      ) : (
        <div className="asset-grid">
          {data.items.map((a) => (
            <Link key={a.wbId} to={`/assets/${a.wbId}`} className="asset-tile">
              <p className="eyebrow">{humanize(a.category)}</p>
              <h3>
                {a.brand ?? "Unnamed"} {a.model}
              </h3>
              <p className="mono small">{a.wbId}</p>
              <div className="badges">
                <Badge value={a.status} />
                {a.tokenizationStatus !== "NOT_TOKENIZED" && <Badge value={a.tokenizationStatus} />}
              </div>
              <p className="tile-score">
                <span className="gold">{a.trustScore}</span>{" "}
                <span className="muted small">Trust Score</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
