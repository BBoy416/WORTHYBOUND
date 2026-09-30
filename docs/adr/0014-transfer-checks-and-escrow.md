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

**Checks before buying, in person (2026-10-04).** A signed-in buyer starts a check from the
passport (`POST /assets/:wbId/purchase-checks`); it stays open 60 minutes, one per buyer and item,
at most 10 per buyer and 10 per item per day. The check shows a 6-character code (valid 5 minutes,
renewable) that the owner signs on their asset page (`POST /assets/:wbId/owner-confirmations`,
text `WorthyBound: I confirm to a buyer that I own <WB ID>.\nCode: <code>`); the confirmation is
final and names neither wallet nor person. The buyer photographs the item with the live camera,
one photo per capture shot of the category without the code shot; photos are stored without
metadata and shown only to the buyer. The recorded photos are the verifiers' photos and the owner's
latest completed capture session (at most 8), compared by the AI check engine (ADR 0013); when
the passport is revoked, without recorded photos, or when the comparison fails, the result is
`INCONCLUSIVE` with the reason. The buyer sees recorded photos
that are public on the passport; private ones are compared but never shown. The model's summary
is stored for reviewers, not shown to the buyer. Checks are audited.

**Check before buying, remotely.** The buyer requests a live check. WorthyBound gives the seller a
one-time code that the buyer also sees; within 24 hours the seller films the item with the code
in view, in a capture session. The buyer sees the result and the video. This proves the seller
has the item now and that it matches the token.

**Checks before buying, remotely (2026-10-05).** A signed-in buyer requests a remote check from
the passport (`POST /assets/:wbId/remote-checks`); it stays open 24 hours, one per buyer and item,
and counts toward the daily limits of checks, with at most 3 remote checks per item per day. The
check has a 6-character code that the buyer sees throughout. The owner sees the open requests on
their asset page, without the buyer (`GET /assets/:wbId/remote-checks`), and films the item in a
capture session started from the request
(`POST /assets/:wbId/remote-checks/:checkId/capture-session`): the session uses the check's code,
ends with the check at the latest, and asks for the category's capture shots, including the code
shot, then a `VIDEO` shot turning the item around with the code in view (MP4 or QuickTime, at
most 100 MiB). These sessions are not counted in the owner's capture limits, and their shots are
not counted in the limit of evidence files per asset. The owner's account filming the item shows
the buyer "confirmed current owner"; no wallet signature is asked. When the session completes, the
buyer can watch the video through a 5-minute link (`POST /purchase-checks/:checkId/video`) to a
copy without its metadata boxes (`udta`, `meta`, `uuid`, turned into `free` boxes of the same
size, so the video plays unchanged); the original stays sealed as evidence. The buyer also sees
what the AI check found in the code photo (`owner.codeCheck`: the code shown, missing or
different, the photo failed or was unclear, or the check is pending or unavailable), and the
session's photos without the code shot are compared with the recorded photos as in person.
Sessions filmed for a remote check are never recorded photos for other checks. The shots are
evidence of the asset like any capture session. The web app records the video from the live
camera (`MediaRecorder`) as MP4 without sound, for at most 60 seconds; browsers that cannot
record MP4 are asked to use another. Checks are audited.

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
legal advice before payments leave devnet.

**Payments on devnet in SOL (2026-10-03).** Until a provider is chosen, payments are in SOL on
devnet. The seller sets a price when starting a transfer (`priceLamports`, default 0 for none);
the database keeps it fixed. The transfer transaction pays the price from the buyer to the seller
(a System program transfer) before `transfer_asset`, so the payment and the transfer both happen
or neither does; the program is unchanged. The buyer sees the price before accepting and when
signing, and WorthyBound checks the buyer's balance before accepting the signature. This covers
in-person transfers; escrow for shipped items is still to come.

**Escrow on devnet in SOL (2026-10-07).** A shipped transfer (`delivery: "SHIPPED"`, with a
price) is escrowed without a program change. When the buyer accepts, the oracle creates the
transfer's durable nonce account, which also holds the escrow, and a second nonce account for the
payment. Both parties sign the transfer, which pays the seller from the escrow account (a nonce
withdrawal the oracle signs) together with `transfer_asset`; the buyer then signs the payment of
the price into escrow (`POST /transfers/:id/payment`). A signed payment stays valid until the
payment nonce advances, so the worker gives up on one it cannot confirm only after advancing that
nonce; it then records the payment if the escrow holds the price, or asks the buyer to sign a new
one. A refund returns the price and advances the escrow nonce, so the signed transfer can no
longer run. Deadlines:

- The seller films the item and the sealed package with the session's code
  (`POST /transfers/:id/shipment-session`) and ships within 3 days of payment, or the buyer is
  refunded. Until shipping, the seller can cancel with a refund.
- The buyer confirms delivery within 21 days of shipping. Afterwards they can cancel with a
  refund, or extend by 7 days up to 3 times. Without either, the sale is released 7 days after the
  delivery period.
- Confirming delivery starts a receipt check (`kind: "RECEIPT"`): within 48 hours the buyer
  photographs the package with the seller's code, then the item. The photos are compared with the
  seller's photos before shipping. A match releases the sale; no match holds it for an
  administrator; otherwise it is released 7 days after delivery.
- The buyer can report a problem until the release (`POST /transfers/:id/dispute`). An
  administrator releases the sale or refunds the buyer (`POST /admin/transfers/:id/resolution`).
  A transfer that could not be sent is held the same way and can only be refunded.

Photos taken before shipping are not recorded photos for other checks and do not count toward the
evidence limit. If the owner reports the item lost or stolen, a paid escrow is refunded before
shipping and held for an administrator after.

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
- Needs guided capture (ADR 0013, in the web app since 2026-10-01). Payments are in SOL on devnet
  only; a payment provider does not exist yet.
- Verifier-fitted physical tags need their own decision when introduced.
