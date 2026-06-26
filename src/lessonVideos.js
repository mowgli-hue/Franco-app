// Lesson → YouTube video URL map.
//
// HOW TO USE:
// 1. When you finish a HeyGen lesson and upload to YouTube, paste the URL below.
// 2. Use the youtu.be short form: "https://youtu.be/dQw4w9WgXcQ"
// 3. The lesson card will automatically show the video at the top of the lesson.
// 4. If a lesson is not in this map, the card shows: "🎬 Premium video coming soon"
//
// EXAMPLE filled in:
//   "f-01": { url: "https://youtu.be/abc123XYZ", durationMin: 9 },
//
// FREE TIER (Foundation 25): videos are free for all users
// PREMIUM TIER (A1+): videos require active subscription

export const LESSON_VIDEOS = {
  // ─── Foundation 25 (FREE) ───────────────────────────────────────────────────
  "f-01": { url: "https://youtu.be/geKhmWIpI1s", durationMin: 9,  tier: "free" }, // Bonjour Canada
  "f-02": { url: null, durationMin: 8,  tier: "free" }, // Pronunciation Part 1
  "f-03": { url: null, durationMin: 8,  tier: "free" }, // Je m'appelle
  "f-04": { url: null, durationMin: 8,  tier: "free" }, // Numbers 0-20
  "f-05": { url: null, durationMin: 9,  tier: "free" }, // When you don't understand
  "f-06": { url: null, durationMin: 9,  tier: "free" }, // Week 1 capstone
  "f-07": { url: null, durationMin: 9,  tier: "free" }, // Être
  "f-08": { url: null, durationMin: 9,  tier: "free" }, // Avoir
  "f-09": { url: null, durationMin: 8,  tier: "free" }, // Family
  "f-10": { url: null, durationMin: 7,  tier: "free" }, // Where you live
  "f-11": { url: null, durationMin: 8,  tier: "free" }, // Your work
  "f-12": { url: null, durationMin: 9,  tier: "free" }, // Week 2 capstone
  "f-13": { url: null, durationMin: 9,  tier: "free" }, // Numbers 20-1000
  "f-14": { url: null, durationMin: 8,  tier: "free" }, // Time
  "f-15": { url: null, durationMin: 7,  tier: "free" }, // Dates
  "f-16": { url: null, durationMin: 8,  tier: "free" }, // Money & paying
  "f-17": { url: null, durationMin: 7,  tier: "free" }, // Weather & winter
  "f-18": { url: null, durationMin: 9,  tier: "free" }, // Week 3 capstone
  "f-19": { url: null, durationMin: 7,  tier: "free" }, // Colors
  "f-20": { url: null, durationMin: 9,  tier: "free" }, // Grocery store
  "f-21": { url: null, durationMin: 9,  tier: "free" }, // Restaurants
  "f-22": { url: null, durationMin: 8,  tier: "free" }, // Body parts / doctor
  "f-23": { url: null, durationMin: 8,  tier: "free" }, // Pharmacy
  "f-24": { url: null, durationMin: 9,  tier: "free" }, // Directions & metro
  "f-25": { url: null, durationMin: 10, tier: "free" }, // Foundation capstone

  // ─── A1 — Beginner (PREMIUM) ────────────────────────────────────────────────
  "a1-01": { url: null, durationMin: 9, tier: "premium" }, "a1-02": { url: null, durationMin: 9, tier: "premium" },
  "a1-03": { url: null, durationMin: 9, tier: "premium" }, "a1-04": { url: null, durationMin: 9, tier: "premium" },
  "a1-05": { url: null, durationMin: 9, tier: "premium" }, "a1-06": { url: null, durationMin: 9, tier: "premium" },
  "a1-07": { url: null, durationMin: 9, tier: "premium" }, "a1-08": { url: null, durationMin: 9, tier: "premium" },
  "a1-09": { url: null, durationMin: 9, tier: "premium" }, "a1-10": { url: null, durationMin: 9, tier: "premium" },
  "a1-11": { url: null, durationMin: 9, tier: "premium" }, "a1-12": { url: null, durationMin: 9, tier: "premium" },
  "a1-13": { url: null, durationMin: 9, tier: "premium" }, "a1-14": { url: null, durationMin: 9, tier: "premium" },
  "a1-15": { url: null, durationMin: 9, tier: "premium" }, "a1-16": { url: null, durationMin: 9, tier: "premium" },
  "a1-17": { url: null, durationMin: 9, tier: "premium" }, "a1-18": { url: null, durationMin: 9, tier: "premium" },
  "a1-19": { url: null, durationMin: 9, tier: "premium" }, "a1-20": { url: null, durationMin: 9, tier: "premium" },
  "a1-21": { url: null, durationMin: 9, tier: "premium" }, "a1-22": { url: null, durationMin: 9, tier: "premium" },
  "a1-23": { url: null, durationMin: 9, tier: "premium" }, "a1-24": { url: null, durationMin: 9, tier: "premium" },
  "a1-25": { url: null, durationMin: 9, tier: "premium" }, "a1-26": { url: null, durationMin: 9, tier: "premium" },
  "a1-27": { url: null, durationMin: 9, tier: "premium" }, "a1-28": { url: null, durationMin: 9, tier: "premium" },
  "a1-29": { url: null, durationMin: 9, tier: "premium" }, "a1-30": { url: null, durationMin: 9, tier: "premium" },
  "a1-31": { url: null, durationMin: 9, tier: "premium" }, "a1-32": { url: null, durationMin: 9, tier: "premium" },
  "a1-33": { url: null, durationMin: 9, tier: "premium" }, "a1-34": { url: null, durationMin: 9, tier: "premium" },
  "a1-35": { url: null, durationMin: 9, tier: "premium" }, "a1-36": { url: null, durationMin: 9, tier: "premium" },
  "a1-37": { url: null, durationMin: 9, tier: "premium" }, "a1-38": { url: null, durationMin: 9, tier: "premium" },
  "a1-39": { url: null, durationMin: 9, tier: "premium" }, "a1-40": { url: null, durationMin: 9, tier: "premium" },

  // ─── A2, B1, B2, CLB Intensive (PREMIUM, video TBD) ────────────────────────
  // Fill these in as they're produced.
};

/**
 * Get the video URL for a lesson, or null if not yet produced.
 * Use this in the lesson card render.
 */
export function getLessonVideo(lessonId) {
  return LESSON_VIDEOS[lessonId] || null;
}

/**
 * Is this lesson's video free for all users?
 */
export function isLessonVideoFree(lessonId) {
  const v = LESSON_VIDEOS[lessonId];
  return v?.tier === "free";
}

/**
 * Has the video been produced yet?
 */
export function isLessonVideoReady(lessonId) {
  const v = LESSON_VIDEOS[lessonId];
  return !!(v && v.url);
}

/**
 * Convert various YouTube URL formats into the embed URL.
 * Supports: https://youtu.be/ID, https://www.youtube.com/watch?v=ID
 */
export function youTubeEmbedUrl(url) {
  if (!url) return null;
  // enablejsapi=1 lets us pause/resume the video (for the "Ask Sophie" feature)
  // via postMessage; playsinline keeps it inline on iOS.
  const params = "enablejsapi=1&playsinline=1&rel=0";
  try {
    // https://youtu.be/ID
    let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    if (m) return `https://www.youtube.com/embed/${m[1]}?${params}`;
    // https://www.youtube.com/watch?v=ID
    m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) return `https://www.youtube.com/embed/${m[1]}?${params}`;
    // Already an embed URL
    if (url.includes("/embed/")) return url.includes("?") ? url : `${url}?${params}`;
  } catch { /* ignore */ }
  return null;
}

export default LESSON_VIDEOS;
