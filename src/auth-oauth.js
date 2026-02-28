/**
 * src/auth-oauth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OAuth 소셜 로그인 (Google, GitHub)
 *
 * 지원 전략:
 *   - Google OAuth 2.0  (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 *   - GitHub OAuth 2.0  (GITHUB_CLIENT_ID  / GITHUB_CLIENT_SECRET)
 *
 * 환경 변수가 없으면 전략 등록을 건너뛰고 /api/auth/oauth/status에서 알림.
 *
 * 사용 흐름:
 *   GET /api/auth/google          → Google 로그인 리다이렉트
 *   GET /api/auth/google/callback → 콜백 → 토큰 발급 → 클라이언트로 리다이렉트
 *   GET /api/auth/github          → GitHub 로그인 리다이렉트
 *   GET /api/auth/github/callback → 콜백 → 토큰 발급 → 클라이언트로 리다이렉트
 *   GET /api/auth/oauth/status    → 어떤 OAuth가 설정됐는지 확인
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const crypto         = require('crypto');

// Kakao/Naver/Apple은 패키지가 없을 수도 있으므로 동적 require
let KakaoStrategy = null;
let NaverStrategy = null;
let AppleStrategy = null;
try { KakaoStrategy = require('passport-kakao').default || require('passport-kakao'); } catch {}
try { NaverStrategy = require('passport-naver-v2').default || require('passport-naver-v2'); } catch {}
try { AppleStrategy = require('passport-apple'); } catch {}

// ─── 토큰 생성 (src/auth.js 방식과 동일) ─────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── OAuth 전략 등록 ─────────────────────────────────────────────────────────

/**
 * Passport 전략을 초기화합니다.
 * db 파라미터: { getUserByEmail, upsertOAuthUser, insertToken }
 *
 * @param {{ getUserByEmail, upsertOAuthUser, insertToken }} db
 * @returns {{ passport, enabledProviders: string[] }}
 */
function initOAuthStrategies(db) {
  const enabledProviders = [];

  // ── Google ──────────────────────────────────────────────────────────────────
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/google/callback`
          : '/api/auth/google/callback',
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || `google_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:    'google',
            providerId:  profile.id,
            email,
            name:        profile.displayName || email.split('@')[0],
            avatar:      profile.photos?.[0]?.value || null,
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    ));
    enabledProviders.push('google');
  }

  // ── GitHub ───────────────────────────────────────────────────────────────────
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy(
      {
        clientID:     process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/github/callback`
          : '/api/auth/github/callback',
        scope: ['user:email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || `github_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:    'github',
            providerId:  profile.id,
            email,
            name:        profile.displayName || profile.username || email.split('@')[0],
            avatar:      profile.photos?.[0]?.value || null,
          });
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    ));
    enabledProviders.push('github');
  }

  // ── Kakao ───────────────────────────────────────────────────────────────────
  if (KakaoStrategy && process.env.KAKAO_CLIENT_ID) {
    passport.use(new KakaoStrategy(
      {
        clientID:     process.env.KAKAO_CLIENT_ID,
        clientSecret: process.env.KAKAO_CLIENT_SECRET || '',
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/kakao/callback`
          : '/api/auth/kakao/callback',
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const kakaoAccount = profile._json?.kakao_account;
          const email = kakaoAccount?.email || `kakao_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:   'kakao',
            providerId: String(profile.id),
            email,
            name:       profile.displayName || profile.username || email.split('@')[0],
            avatar:     profile._json?.properties?.thumbnail_image || null,
          });
          done(null, user);
        } catch (err) { done(err); }
      }
    ));
    enabledProviders.push('kakao');
  }

  // ── Naver ───────────────────────────────────────────────────────────────────
  if (NaverStrategy && process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET) {
    passport.use(new NaverStrategy(
      {
        clientID:     process.env.NAVER_CLIENT_ID,
        clientSecret: process.env.NAVER_CLIENT_SECRET,
        callbackURL:  process.env.OAUTH_CALLBACK_BASE
          ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/naver/callback`
          : '/api/auth/naver/callback',
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.email || `naver_${profile.id}@oauth.local`;
          const user  = await db.upsertOAuthUser({
            provider:   'naver',
            providerId: String(profile.id),
            email,
            name:       profile.name || profile.nickname || email.split('@')[0],
            avatar:     profile.profileImage || null,
          });
          done(null, user);
        } catch (err) { done(err); }
      }
    ));
    enabledProviders.push('naver');
  }

  // ── Apple ────────────────────────────────────────────────────────────────────
  // 필요 환경변수: APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (p8 내용 또는 경로)
  if (AppleStrategy && process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID) {
    const privateKeyString = process.env.APPLE_PRIVATE_KEY
      ? process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : null;

    if (privateKeyString) {
      passport.use(new AppleStrategy(
        {
          clientID:     process.env.APPLE_CLIENT_ID,
          teamID:       process.env.APPLE_TEAM_ID,
          keyID:        process.env.APPLE_KEY_ID,
          privateKeyString,
          callbackURL:  process.env.OAUTH_CALLBACK_BASE
            ? `${process.env.OAUTH_CALLBACK_BASE}/api/auth/apple/callback`
            : '/api/auth/apple/callback',
          passReqToCallback: false,
        },
        async (_accessToken, _refreshToken, idToken, profile, done) => {
          try {
            // Apple은 첫 로그인 시에만 이메일 제공
            const email = idToken?.email || profile?.email || `apple_${profile?.id}@oauth.local`;
            const user  = await db.upsertOAuthUser({
              provider:   'apple',
              providerId: String(profile?.id || idToken?.sub),
              email,
              name:       profile?.name?.firstName
                ? `${profile.name.firstName} ${profile.name.lastName || ''}`.trim()
                : email.split('@')[0],
              avatar:     null,
            });
            done(null, user);
          } catch (err) { done(err); }
        }
      ));
      enabledProviders.push('apple');
    }
  }

  // Passport 세션 직렬화 (userId만 저장)
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await db.getUserById(id);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });

  return { passport, enabledProviders };
}

// ─── 라우터 팩토리 ─────────────────────────────────────────────────────────────

/**
 * OAuth 라우터를 생성합니다.
 *
 * @param {{ passport, enabledProviders, insertToken, CLIENT_ORIGIN }} deps
 * @returns {express.Router}
 */
function createOAuthRouter({ passport, enabledProviders, insertToken, CLIENT_ORIGIN }) {
  const express = require('express');
  const router  = express.Router();

  const origin     = CLIENT_ORIGIN || process.env.CLIENT_ORIGIN || 'http://localhost:4747';
  const clientPage = `${origin}/orbit3d.html`;

  // ── OAuth 설정 상태 확인 ────────────────────────────────────────────────────
  router.get('/oauth/status', (_req, res) => {
    res.json({
      enabledProviders,
      google:  enabledProviders.includes('google'),
      github:  enabledProviders.includes('github'),
      kakao:   enabledProviders.includes('kakao'),
      naver:   enabledProviders.includes('naver'),
      apple:   enabledProviders.includes('apple'),
    });
  });

  // ── Google 로그인 ───────────────────────────────────────────────────────────
  if (enabledProviders.includes('google')) {
    router.get('/google',
      passport.authenticate('google', { scope: ['profile', 'email'], session: false })
    );

    router.get('/google/callback',
      passport.authenticate('google', { session: false, failureRedirect: `${origin}/?oauth_error=google_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        // 토큰을 URL 프래그먼트로 전달 (서버 로그에 남지 않음)
        res.redirect(`${clientPage}?oauth_token=${token}&provider=google`);
      }
    );
  } else {
    router.get('/google', (_req, res) =>
      res.status(501).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' })
    );
  }

  // ── GitHub 로그인 ───────────────────────────────────────────────────────────
  if (enabledProviders.includes('github')) {
    router.get('/github',
      passport.authenticate('github', { scope: ['user:email'], session: false })
    );

    router.get('/github/callback',
      passport.authenticate('github', { session: false, failureRedirect: `${origin}/?oauth_error=github_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        res.redirect(`${clientPage}?oauth_token=${token}&provider=github`);
      }
    );
  } else {
    router.get('/github', (_req, res) =>
      res.status(501).json({ error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.' })
    );
  }

  // ── Kakao 로그인 ─────────────────────────────────────────────────────────────
  if (enabledProviders.includes('kakao')) {
    router.get('/kakao', passport.authenticate('kakao', { session: false }));
    router.get('/kakao/callback',
      passport.authenticate('kakao', { session: false, failureRedirect: `${origin}/?oauth_error=kakao_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        res.redirect(`${clientPage}?oauth_token=${token}&provider=kakao`);
      }
    );
  } else {
    router.get('/kakao', (_req, res) =>
      res.status(501).json({ error: 'Kakao OAuth not configured. Set KAKAO_CLIENT_ID.' })
    );
  }

  // ── Naver 로그인 ─────────────────────────────────────────────────────────────
  if (enabledProviders.includes('naver')) {
    router.get('/naver', passport.authenticate('naver', { session: false }));
    router.get('/naver/callback',
      passport.authenticate('naver', { session: false, failureRedirect: `${origin}/?oauth_error=naver_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        res.redirect(`${clientPage}?oauth_token=${token}&provider=naver`);
      }
    );
  } else {
    router.get('/naver', (_req, res) =>
      res.status(501).json({ error: 'Naver OAuth not configured. Set NAVER_CLIENT_ID and NAVER_CLIENT_SECRET.' })
    );
  }

  // ── Apple 로그인 ──────────────────────────────────────────────────────────────
  // Apple은 POST callback 사용 (Apple 정책)
  if (enabledProviders.includes('apple')) {
    router.get('/apple',  passport.authenticate('apple', { session: false }));
    router.post('/apple/callback',
      passport.authenticate('apple', { session: false, failureRedirect: `${origin}/?oauth_error=apple_failed` }),
      async (req, res) => {
        const token = generateToken();
        await insertToken(req.user.id, token);
        res.redirect(`${clientPage}?oauth_token=${token}&provider=apple`);
      }
    );
  } else {
    router.get('/apple', (_req, res) =>
      res.status(501).json({ error: 'Apple OAuth not configured. Set APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY.' })
    );
  }

  return router;
}

module.exports = { initOAuthStrategies, createOAuthRouter, generateToken };
