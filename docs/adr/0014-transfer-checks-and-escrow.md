# ADR 0014: Checks before buying, and escrowed transfers

- Status: Proposed (amends ADR 0002)
- Date: 2026-09-29

## Context

ADR 0002 makes tokens non-transferable except through WorthyBound. That stops a thief moving a
token, but not a seller selling an item they do not have, showing a genuine item and handing over
a fake, or shipping something else. Buyers need to check the item and the seller on WorthyBound
before paying, and the token (with its certificates) must not change hands until the buyer has the
matching item. A sale should not require a new appraisal: certificates stay valid until they
expire (ADR 0012).

## Decision

**Check before buying, in person.** On the WorthyBound site or app, while buyer and seller meet:

1. **Passport.** The buyer opens the live passport by QR code or WB ID. Stolen, lost, disputed and
   revoked statuses, and certificates with their validity, are shown prominently.
2. **Seller.** The buyer asks WorthyBound for a one-time code; the seller signs it with the owner's
   wallet (valid 5 minutes). The buyer sees "confirmed current owner", never the seller's wallet or
   identity.
3. **Item.** The buyer runs a guided capture of the item in front of them (ADR 0013). WorthyBound
   compares it with the asset's recorded photos: the verifier's, and the latest capture session.
   The buyer sees `MATCH`, `NO_MATCH` or `INCONCLUSIVE`, with the photos side by side.

The buyer must be signed in; checks are rate limited and audited, so they cannot be used to probe
other people's items. A result means "matches the recorded item", never a guarantee.

**Check before buying, remotely.** The buyer requests a live check. WorthyBound gives the seller a
one-time code that the buyer also sees; within 24 hours the seller films the item with the code
in view, in a capture session. The buyer sees the result and the video. This proves the seller
has the item now and that it matches the token.

**In-person transfer.** When the checks pass, the buyer pays and the program transfers the token
in the same transaction (ADR 0002 steps 2-3). No escrow wait is needed; the buyer checked the item.

**Escrowed transfer (shipped items).**

1. The seller starts the transfer; the buyer (KYC'd, ADR 0004) accepts and pays into escrow.
2. The token stays frozen with the seller and the passport shows "transfer in progress".
3. Before shipping, the seller runs a capture session of the item and of the sealed package with a
   code written on it.
4. Within 48 hours of delivery, the buyer runs a capture session of the package and the item.
5. **Match:** the token and the payment are released in one transaction.
6. **No match, or the buyer reports a problem:** the transfer is disputed; token and payment stay in
   escrow. A professional verifier inspects the item; the losing party pays the inspection. The
   outcome releases the sale, or refunds the buyer when the seller has the item back (checked by a
   capture session against the seller's pre-shipment photos).
7. **No response:** if the buyer does nothing within 7 days of confirmed delivery, the sale is
   released.

**After a transfer (amends ADR 0002, point 4).** Authentication, documentation and certificates
keep counting until they expire. Possession and condition no longer need reverification by a
verifier: the buyer's accepted receipt capture (or the in-person item check) and KYC record
possession for the new custody period, and a capture session can confirm the condition. Condition
grades from before the transfer stay flagged `fromPreviousCustody` (ADR 0007).

**Still blocked.** Transfers stay impossible while an asset is `DISPUTED` or `REPORTED_STOLEN`
(ADR 0002).

**Payments.** Deferred; not part of the demo (Solana School, 12 October 2026). Holding a buyer's
money is regulated whether or not it moves on Solana. The preferred direction is an outside
payment provider (e.g. PayPal) that holds and releases the money, with WorthyBound acting only as
the on-chain verifier: it records checks and releases the token when the provider confirms
payment. A stablecoin escrow in the WorthyBound program remains an alternative. The choice needs
legal advice before payments are built.

**Remaining fraud and its limits.**

| Fraud                                                 | Countermeasure                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Seller shows or ships a fake with a copied serial     | Matching uses the item's own marks (wear, scratches, details), not only the serial     |
| Buyer claims "fake" and returns a fake                | Seller's pre-shipment capture and sealed package; return checked; a professional rules |
| Collusion to launder a stolen item                    | KYC on both sides, stolen items blocked, audit trail                                   |
| A super-fake that photos cannot tell apart            | Meet at a verifier's premises, or tamper-evident NFC tags fitted by a verifier (later) |
| Selling an item one does not have, or a fake passport | Live passport, seller signs a challenge, live capture with the buyer's code            |

## Consequences

- Fraud becomes detectable, traceable to KYC'd people and costly; it is not impossible, and the
  passport keeps saying so.
- The Phase 10 spike must confirm that the program can hold the token frozen during escrow and
  release it together with the payment.
- Professional verifiers are needed only for disputes and high-value items, not for every sale.
- Needs guided capture (ADR 0013), a camera-capable client and a payment provider; none exists yet.
- Verifier-fitted physical tags need their own decision when introduced.
