# Marketing CMS Product Specification

Versi: 1.2  
Status: accepted product scope through P-011/P-012

## Outcome

Superadmin dapat mengubah konten marketing publik tanpa deploy frontend, sementara layout,
brand, accessibility, motion, dan responsive behavior tetap dikendalikan kode. CMS ini
structured content, bukan website builder.

## Scope MVP

- Page: Produk (/), Untuk Sekolah (/untuk-sekolah), dan Harga (/harga).
- Global slots: navigation, footer, default SEO, dan global CTA registry.
- Page slots: metadata, eyebrow, heading, body, CTA, proof/workflow/audience/trust blocks,
  FAQ, final CTA, dan media reference.
- Workflow: draft, preview, validate, publish, unpublish, restore-as-new-draft.
- Satu locale awal id-ID.
- Audit, optimistic concurrency, ETag, dan version history.

## Explicit non-scope

- Drag-and-drop layout.
- Arbitrary HTML, CSS, JavaScript, iframe, atau runtime component name.
- Plugin marketplace.
- Tenant/school-specific public landing.
- Approval chain multi-role; MVP hanya superadmin dengan confirmation/step-up.
- Scheduled publish dan multi-locale UI; schema tidak boleh menutup kemungkinan fase lanjut.
- Mengubah harga/claim yang belum diterima dalam decision register.

## Content model

Page document:

- id, slug, locale, schemaVersion, status;
- title/SEO metadata;
- ordered blocks;
- publishedVersion, draftRevision, created/updated metadata.

CTA:

- id;
- label;
- href;
- variant: primary, secondary, text;
- placement;
- audience: teacher, school, all;
- trackingKey;
- enabled;
- optional external flag and accessible label.

Media reference:

- assetId;
- alt text;
- presentation role;
- width/height or aspect ratio;
- optional focal point.

Block types are finite, versioned, and mapped to frontend components. Unsupported blocks are
rejected on publish when frontend compatibility is known; the public renderer also fails
section-locally instead of blanking the page.

## Publish rules

1. Draft save validates structure and unsafe URLs.
2. Preview uses authenticated draft data and no-store.
3. Publish validates required slots, decision-gated fields, assets, schema compatibility,
   and current revision.
4. Published versions are immutable.
5. Restore copies an old version into a new draft; it never edits history.
6. Every mutation writes an audit event with actor, action, target, revision, request ID, and
   safe changed-field summary.

## Availability and performance

- Public response supports ETag and Cache-Control.
- Frontend revalidates within at most 60 seconds for MVP.
- Last accepted seed is bundled with frontend and schema-validated in CI.
- A CMS outage cannot remove core navigation, hero, CTA, or footer.
- CMS public read does not require Redis, queue, object storage, or worker.

## Success metrics

- Publish-to-visible latency p95 <= 60 seconds.
- Zero public exposure of draft content.
- Zero blank landing caused by CMS/schema/motion failure.
- 100% publish/restore actions represented in audit log.
- Content change does not require frontend deployment for supported fields.

## Acceptance

- Permission matrix tests cover visitor, teacher, school_admin, and superadmin.
- Concurrent editor conflict is detected.
- Unsafe CTA schemes and arbitrary markup are rejected.
- Preview and public cache behavior are verified.
- Restore preserves complete history.
- Desktop/mobile rendering is visually reviewed for all supported pages.
