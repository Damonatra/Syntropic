"""Module 7 — Spatial GIS Proximity Clustering.

Groups geocoded distributors into regional tactical clusters and arms the
high-touch team with localized hooks the moment a meeting lands inside one.

Spatial engine
--------------
* PostGIS (when the extension is available) powers proximity lookups via
  ``ST_DWithin`` / ``ST_Distance`` over a GIST-indexed ``geography`` column.
* Clustering itself runs through a deterministic haversine DBSCAN implemented
  in pure Python: it is O(n²) on B2B-scale datasets (hundreds to low-thousands
  of rows), needs no scientific stack, and produces byte-stable cluster keys
  so re-runs upsert instead of duplicating.

Seed tactical clusters include the Gulf Coast PVF belt, Chicago metro,
Toronto/Golden Horseshoe (CASL-aware), DFW, the Great Lakes fluid-power rim,
Atlanta, SoCal ports and the LAPPSET corridor (Lamu–Isiolo axis) for East
Africa expansion accounts.

Outputs
-------
* ``lead_clusters``            — upserted cluster rows (idempotent re-runs)
* ``prospects.cluster_id``     — membership binding
* ``outbox`` events            — ``cluster.prospects_clustered``,
                                 ``cluster.meeting_proximity_detected``

Usage
-----
    python -m vertebra.spatial.clustering cluster
    python -m vertebra.spatial.clustering hook --lat 29.76 --lng -95.37 \
        --first-name Jane --vertical pvf
    python -m vertebra.spatial.clustering nearest --lat 43.65 --lng -79.38
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid as uuid_mod
from collections import Counter, deque
from dataclasses import dataclass
from typing import Any

from vertebra.config.settings import SpatialSettings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger
from vertebra.models.domain import LeadCluster, MeetingContext, RegionalHook

log = get_logger("spatial.clustering")

# --------------------------------------------------------------------------- #
# Seed tactical clusters
# --------------------------------------------------------------------------- #


@dataclass(slots=True, frozen=True)
class SeedCluster:
    """A named territory anchor used to label dense prospect regions."""

    seed_id: str
    name: str
    anchor_city: str
    anchor_country: str
    lat: float
    lng: float
    vertical_affinity: str | None = None


SEED_CLUSTERS: tuple[SeedCluster, ...] = (
    SeedCluster(
        "gulf-coast-pvf-belt", "Gulf Coast PVF Belt", "Houston", "United States",
        29.7604, -95.3698, "pvf",
    ),
    SeedCluster(
        "chicago-metro-corridor", "Chicago Metro Distribution Corridor", "Chicago",
        "United States", 41.8781, -87.6298,
    ),
    SeedCluster(
        "golden-horseshoe", "Golden Horseshoe Industrial Arc", "Toronto", "Canada",
        43.6532, -79.3832,
    ),
    SeedCluster(
        "dfw-nexus", "DFW Distribution Nexus", "Dallas", "United States",
        32.7767, -96.7970,
    ),
    SeedCluster(
        "great-lakes-rim", "Great Lakes Industrial Rim", "Cleveland", "United States",
        41.4993, -81.6944, "fluid_power",
    ),
    SeedCluster(
        "southeast-fulcrum", "Southeast Fulcrum", "Atlanta", "United States",
        33.7490, -84.3880, "hvac",
    ),
    SeedCluster(
        "socal-port-complex", "SoCal Port Complex", "Los Angeles", "United States",
        34.0522, -118.2437,
    ),
    SeedCluster(
        "lappset-corridor", "LAPPSET Corridor — Lamu–Isiolo Axis", "Lamu", "Kenya",
        -2.2717, 40.9020,
    ),
)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres (earth radius 6,371,008.8 m)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(min(1.0, math.sqrt(a)))


def dbscan_haversine(
    points: list[tuple[float, float]], *, eps_m: float, min_points: int
) -> list[int | None]:
    """Deterministic DBSCAN over haversine distance.

    Returns one label per point (``None`` = noise). Standard expansion
    semantics: border points adopt their first core cluster.
    """
    n = len(points)
    labels: list[int | None] = [None] * n
    visited = [False] * n
    if n == 0:
        return labels

    def region_query(i: int) -> list[int]:
        lat_i, lng_i = points[i]
        return [
            j
            for j in range(n)
            if j != i and haversine_m(lat_i, lng_i, points[j][0], points[j][1]) <= eps_m
        ]

    cluster_id = 0
    for i in range(n):
        if visited[i]:
            continue
        visited[i] = True
        neighbours = region_query(i)
        if len(neighbours) + 1 < min_points:
            continue  # candidate noise; may still be claimed as a border point
        labels[i] = cluster_id
        queue: deque[int] = deque(neighbours)
        while queue:
            j = queue.popleft()
            if not visited[j]:
                visited[j] = True
                j_neighbours = region_query(j)
                if len(j_neighbours) + 1 >= min_points:
                    for k in j_neighbours:
                        if not visited[k] and labels[k] is None:
                            queue.append(k)
            if labels[j] is None:
                labels[j] = cluster_id
        cluster_id += 1
    return labels


def _dominant_vertical(values: list[str | None]) -> str | None:
    counts = Counter(v for v in values if v)
    return counts.most_common(1)[0][0] if counts else None


def _nearest_seed(lat: float, lng: float, max_km: float) -> tuple[SeedCluster, float] | None:
    best: tuple[SeedCluster, float] | None = None
    for seed in SEED_CLUSTERS:
        distance_km = haversine_m(lat, lng, seed.lat, seed.lng) / 1_000.0
        if distance_km <= max_km and (best is None or distance_km < best[1]):
            best = (seed, distance_km)
    return best


# --------------------------------------------------------------------------- #
# Clusterer
# --------------------------------------------------------------------------- #


class SpatialClusterer:
    """Clusters geocoded prospects and triggers localized meeting hooks."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        settings: SpatialSettings | None = None,
        notifier: Any | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._settings = settings or get_settings().spatial
        self._notifier = notifier
        self._postgis: bool | None = None

    # ------------------------------------------------------------------ setup
    async def postgis_available(self) -> bool:
        """Whether the PostGIS extension is live (cached per instance)."""
        if self._postgis is None:
            try:
                row = await self._db.fetchval(
                    "SELECT extname FROM pg_extension WHERE extname = 'postgis'"
                )
                self._postgis = row is not None
            except Exception as exc:  # noqa: BLE001 - probe must not crash callers
                log.warning("postgis_probe_failed", error=str(exc))
                self._postgis = False
            log.info("postgis_status", enabled=self._postgis)
        return self._postgis

    # ------------------------------------------------------------------ batch
    async def cluster_prospects(
        self, *, eps_meters: int | None = None, min_points: int | None = None
    ) -> list[LeadCluster]:
        """DBSCAN all geocoded prospects, upsert clusters, bind membership."""
        eps = eps_meters or self._settings.eps_meters
        min_pts = min_points or self._settings.min_points

        rows = await self._db.fetch(
            """
            SELECT id, name, vertical, city, state_province, country, latitude, longitude
              FROM prospects
             WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            """
        )
        if not rows:
            log.info("cluster_no_geocoded_prospects")
            return []

        points = [(float(r["latitude"]), float(r["longitude"])) for r in rows]
        labels = dbscan_haversine(points, eps_m=float(eps), min_points=min_pts)

        members: dict[int, list[int]] = {}
        for idx, label in enumerate(labels):
            if label is not None:
                members.setdefault(label, []).append(idx)

        clusters: list[LeadCluster] = []
        for _label, idxs in sorted(members.items()):
            lat_c = sum(points[i][0] for i in idxs) / len(idxs)
            lng_c = sum(points[i][1] for i in idxs) / len(idxs)
            radius_m = int(max(haversine_m(lat_c, lng_c, *points[i]) for i in idxs))
            member_ids = [str(rows[i]["id"]) for i in idxs]

            seed_hit = _nearest_seed(lat_c, lng_c, max_km=self._settings.seed_attach_km)
            if seed_hit is not None:
                seed, _distance = seed_hit
                cluster_name = seed.name
                anchor_city, anchor_country = seed.anchor_city, seed.anchor_country
                vertical_focus = _dominant_vertical(
                    [str(rows[i]["vertical"]) for i in idxs]
                ) or seed.vertical_affinity
            else:
                first = rows[idxs[0]]
                cluster_name = f"{first['city'] or first['state_province'] or 'Regional'} Regional Cluster"
                anchor_city = first["city"]
                anchor_country = first["country"]
                vertical_focus = _dominant_vertical([str(rows[i]["vertical"]) for i in idxs])

            cluster_key = "dbscan:" + hashlib.sha256(
                ("|".join(sorted(member_ids))).encode()
            ).hexdigest()[:24]

            cluster = LeadCluster(
                cluster_id="pending",  # replaced after upsert below
                cluster_name=cluster_name,
                anchor_city=anchor_city,
                anchor_country=anchor_country,
                centroid_lat=round(lat_c, 6),
                centroid_lng=round(lng_c, 6),
                radius_m=radius_m,
                density_count=len(idxs),
                vertical_focus=vertical_focus,
                member_prospect_ids=member_ids,
            )
            persisted = await self._upsert_cluster(cluster, cluster_key)
            clusters.append(persisted)

        await self._bind_membership(clusters)
        await self._record_batch_event(clusters, eps=eps, min_pts=min_pts, engine="haversine-dbscan/v1")
        log.info(
            "prospects_clustered",
            prospects=len(rows),
            clusters=len(clusters),
            eps_m=eps,
            min_points=min_pts,
            postgis=await self.postgis_available(),
        )
        return clusters

    async def _upsert_cluster(self, cluster: LeadCluster, cluster_key: str) -> LeadCluster:
        """Idempotent upsert keyed on the deterministic cluster hash."""
        row = await self._db.fetchrow(
            """
            INSERT INTO lead_clusters (
                cluster_key, cluster_name, anchor_city, anchor_country,
                centroid_lat, centroid_lng, radius_m, density_count,
                vertical_focus, centroid_geog, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                    CASE WHEN $10 THEN ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography END, now())
            ON CONFLICT (cluster_key) DO UPDATE SET
                cluster_name   = EXCLUDED.cluster_name,
                anchor_city    = EXCLUDED.anchor_city,
                anchor_country = EXCLUDED.anchor_country,
                centroid_lat   = EXCLUDED.centroid_lat,
                centroid_lng   = EXCLUDED.centroid_lng,
                radius_m       = EXCLUDED.radius_m,
                density_count  = EXCLUDED.density_count,
                vertical_focus = EXCLUDED.vertical_focus,
                centroid_geog  = EXCLUDED.centroid_geog,
                updated_at     = now()
            RETURNING id
            """,
            cluster_key,
            cluster.cluster_name,
            cluster.anchor_city,
            cluster.anchor_country,
            cluster.centroid_lat,
            cluster.centroid_lng,
            cluster.radius_m,
            cluster.density_count,
            cluster.vertical_focus,
            await self.postgis_available(),
        )
        return cluster.model_copy(update={"cluster_id": str(row["id"])})

    async def _bind_membership(self, clusters: list[LeadCluster]) -> None:
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE prospects SET cluster_id = NULL, updated_at = now()
                     WHERE latitude IS NOT NULL AND cluster_id IS NOT NULL
                    """
                )
                for cluster in clusters:
                    await conn.execute(
                        """
                        UPDATE prospects
                           SET cluster_id = $2, updated_at = now()
                         WHERE id = ANY($1::uuid[])
                        """,
                        cluster.member_prospect_ids,
                        uuid_mod.UUID(cluster.cluster_id),
                    )

    async def _record_batch_event(
        self, clusters: list[LeadCluster], *, eps: int, min_pts: int, engine: str
    ) -> None:
        payload = {
            "engine": engine,
            "eps_meters": eps,
            "min_points": min_pts,
            "clusters": [
                {
                    "cluster_id": c.cluster_id,
                    "cluster_name": c.cluster_name,
                    "density_count": c.density_count,
                    "radius_m": c.radius_m,
                    "vertical_focus": c.vertical_focus,
                }
                for c in clusters
            ],
        }
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="cluster",
                    aggregate_id="batch",
                    event_type="cluster.prospects_clustered",
                    payload=payload,
                )

    # -------------------------------------------------------------- proximity
    async def find_cluster_for_point(self, lat: float, lng: float) -> LeadCluster | None:
        """Nearest cluster whose coverage radius reaches the point."""
        max_m = self._settings.max_assign_km * 1_000
        if await self.postgis_available():
            row = await self._db.fetchrow(
                """
                SELECT id, cluster_name, anchor_city, anchor_country, centroid_lat,
                       centroid_lng, radius_m, density_count, vertical_focus,
                       ST_Distance(
                           ST_SetSRID(ST_MakePoint(centroid_lng, centroid_lat), 4326)::geography,
                           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
                       ) AS dist_m
                  FROM lead_clusters
                 WHERE ST_DWithin(
                           ST_SetSRID(ST_MakePoint(centroid_lng, centroid_lat), 4326)::geography,
                           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                           GREATEST(radius_m + 25_000, $3)
                       )
                 ORDER BY dist_m
                 LIMIT 1
                """,
                lat,
                lng,
                max_m,
            )
            if row is not None:
                return self._cluster_from_row(row)
            return None

        rows = await self._db.fetch(
            """
            SELECT id, cluster_name, anchor_city, anchor_country, centroid_lat,
                   centroid_lng, radius_m, density_count, vertical_focus
              FROM lead_clusters
            """
        )
        best: tuple[Any, float] | None = None
        for row in rows:
            distance = haversine_m(lat, lng, float(row["centroid_lat"]), float(row["centroid_lng"]))
            reach = max(float(row["radius_m"]) + 25_000, max_m)
            if distance <= reach and (best is None or distance < best[1]):
                best = (row, distance)
        return self._cluster_from_row(best[0]) if best is not None else None

    @staticmethod
    def _cluster_from_row(row: Any) -> LeadCluster:
        return LeadCluster(
            cluster_id=str(row["id"]),
            cluster_name=row["cluster_name"],
            anchor_city=row["anchor_city"],
            anchor_country=row["anchor_country"],
            centroid_lat=float(row["centroid_lat"]),
            centroid_lng=float(row["centroid_lng"]),
            radius_m=int(row["radius_m"]),
            density_count=int(row["density_count"]),
            vertical_focus=row["vertical_focus"],
        )

    # ----------------------------------------------------------- meeting hook
    async def regional_hook_for_meeting(self, meeting: MeetingContext) -> RegionalHook | None:
        """Localized hook when a booked meeting falls inside a cluster."""
        cluster = await self.find_cluster_for_point(meeting.latitude, meeting.longitude)
        if cluster is None:
            log.info(
                "meeting_outside_clusters",
                meeting_id=meeting.meeting_id,
                lat=meeting.latitude,
                lng=meeting.longitude,
            )
            return None

        onboarded = await self._db.fetchval(
            """
            SELECT count(*) FROM prospects
             WHERE cluster_id = $1
               AND created_at >= date_trunc('month', now())
            """,
            uuid_mod.UUID(cluster.cluster_id),
        )
        onboarded_count = max(int(onboarded or 0), 1)
        vertical_label = (meeting.vertical or cluster.vertical_focus or "industrial").replace("_", " ")
        first_name = meeting.contact_first_name or "there"
        hook_text = (
            f"Hey {first_name}, we're onboarding {onboarded_count} {vertical_label} "
            f"distributors in the {cluster.cluster_name} region this month — "
            f"worth 12 minutes to see what they're seeing?"
        )
        hook = RegionalHook(
            cluster_id=cluster.cluster_id,
            cluster_name=cluster.cluster_name,
            hook_text=hook_text,
            onboarded_this_month=onboarded_count,
            meeting_id=meeting.meeting_id,
        )

        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="cluster",
                    aggregate_id=cluster.cluster_id,
                    event_type="cluster.meeting_proximity_detected",
                    payload={
                        "meeting_id": meeting.meeting_id,
                        "company_name": meeting.company_name,
                        "cluster_name": cluster.cluster_name,
                        "hook_text": hook_text,
                        "onboarded_this_month": onboarded_count,
                    },
                )

        if self._notifier is not None and self._settings.notify_on_meeting_proximity:
            try:
                await self._notifier.dispatch(
                    title="MEETING IN ACTIVE CLUSTER",
                    body=(
                        f"Company: {meeting.company_name or 'unknown'}\n"
                        f"Cluster: {cluster.cluster_name} ({cluster.density_count} distributors)\n"
                        f"Hook: {hook_text}"
                    ),
                    severity="INFO",
                )
            except Exception as exc:  # noqa: BLE001 - notification is best-effort
                log.warning("cluster_proximity_notify_failed", error=str(exc))

        log.info(
            "regional_hook_triggered",
            cluster=cluster.cluster_name,
            meeting_id=meeting.meeting_id,
            onboarded=onboarded_count,
        )
        return hook


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


async def _run(args: list[str]) -> int:
    from vertebra.logging_conf import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    db = Database(settings.database)
    await db.connect()
    outbox = OutboxStore(db)
    clusterer = SpatialClusterer(db, outbox)
    try:
        if args.command == "cluster":
            clusters = await clusterer.cluster_prospects()
            print(json.dumps([c.model_dump() for c in clusters], indent=2, default=str))
        elif args.command == "hook":
            meeting = MeetingContext(
                meeting_id=args.meeting_id,
                contact_first_name=args.first_name,
                company_name=args.company,
                vertical=args.vertical,
                latitude=args.lat,
                longitude=args.lng,
            )
            hook = await clusterer.regional_hook_for_meeting(meeting)
            print(json.dumps(hook.model_dump() if hook else {"hook": None}, indent=2, default=str))
        else:
            cluster = await clusterer.find_cluster_for_point(args.lat, args.lng)
            print(json.dumps(cluster.model_dump() if cluster else {"cluster": None}, indent=2, default=str))
    finally:
        await db.close()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    import argparse
    import asyncio
    import sys

    parser = argparse.ArgumentParser(description="Module 7 — spatial proximity clustering")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("cluster", help="DBSCAN all geocoded prospects and persist clusters")
    hook_p = sub.add_parser("hook", help="Build the localized hook for a meeting coordinate")
    hook_p.add_argument("--lat", type=float, required=True)
    hook_p.add_argument("--lng", type=float, required=True)
    hook_p.add_argument("--first-name")
    hook_p.add_argument("--company")
    hook_p.add_argument("--vertical")
    hook_p.add_argument("--meeting-id")
    near_p = sub.add_parser("nearest", help="Find the cluster covering a coordinate")
    near_p.add_argument("--lat", type=float, required=True)
    near_p.add_argument("--lng", type=float, required=True)
    sys.exit(asyncio.run(_run(parser.parse_args())))
