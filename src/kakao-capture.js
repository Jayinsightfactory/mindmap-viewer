'use strict';
/**
 * kakao-capture.js — 카카오톡 창 자동 캡처
 *
 * 카카오톡이 활성 앱일 때 자동으로 창 캡처 → 서버 전송
 * Vision이 주문 내용을 읽어서 분석 (클립보드 복사 작업 불필요)
 *
 * 트리거:
 *  - 카카오톡이 활성 앱이 되었을 때 (앱 전환 감지)
 *  - 카카오톡 내 창 제목 변경 시 (다른 대화방 열 때)
 *  - 20초마다 자동 (카카오톡 활성 상태 유지 중)
 *
 * 캡처 방식: screenshot-desktop (기존 screen-capture.js와 동일)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

let _running = false;
let _timer = null;
let _lastCaptureTime = 0;
let _lastWindowTitle = '';
let _screenCapture = null;

const CAPTURE_COOLDOWN = 20000; // 20초 쿨다운
const KAKAO_NAMES = ['kakaotalk', 'kakao', '카카오톡'];

function start(screenCaptureModule) {
  _screenCapture = screenCaptureModule;
  _running = true;
  console.log('[kakao-capture] 카카오톡 자동 캡처 시작');
}

/**
 * 앱 전환 이벤트 수신 — keyboard-watcher에서 호출
 * 카카오톡으로 전환 시 캡처 트리거
 */
function onAppSwitch(appName, windowTitle) {
  if (!_running || !_screenCapture) return;
  const isKakao = KAKAO_NAMES.some(k => (appName || '').toLowerCase().includes(k));
  if (!isKakao) return;

  const now = Date.now();
  // 카카오톡 내 대화방 변경 감지 (창 제목 변경)
  const titleChanged = windowTitle && windowTitle !== _lastWindowTitle;
  _lastWindowTitle = windowTitle || '';

  // 쿨다운 체크 (대화방 변경 시에는 바로 캡처)
  if (!titleChanged && now - _lastCaptureTime < CAPTURE_COOLDOWN) return;

  _lastCaptureTime = now;
  // screen-capture의 capture() 호출 (트리거: kakao_switch 또는 kakao_chat_change)
  const trigger = titleChanged ? 'kakao_chat_change' : 'kakao_switch';
  if (typeof _screenCapture.capture === 'function') {
    _screenCapture.capture(trigger);
    console.log(`[kakao-capture] ${trigger}: ${(windowTitle || '').substring(0, 30)}`);
  }
}

/**
 * 카카오톡 활성 상태에서 주기적 캡처 (20초마다)
 * keyboard-watcher의 활성 앱 정보를 받아서 판단
 */
function onPeriodicCheck(activeApp) {
  if (!_running || !_screenCapture) return;
  const isKakao = KAKAO_NAMES.some(k => (activeApp || '').toLowerCase().includes(k));
  if (!isKakao) return;

  const now = Date.now();
  if (now - _lastCaptureTime < CAPTURE_COOLDOWN) return;

  _lastCaptureTime = now;
  if (typeof _screenCapture.capture === 'function') {
    _screenCapture.capture('kakao_periodic');
  }
}

function stop() { _running = false; }
function isRunning() { return _running; }

module.exports = { start, onAppSwitch, onPeriodicCheck, stop, isRunning };
