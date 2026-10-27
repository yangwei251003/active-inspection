"""真实本机 H264 WHIP -> 应用鉴权代理 -> MediaMTX -> WHEP -> 解码帧验证。

画面是变化的合成亮度图；不读取摄像头，不证明实物、浏览器或公网性能。
所有监听仅 127.0.0.1，凭据仅在临时目录中存在，结束时停止所启动进程。
用法：tooling/media-venv/Scripts/python.exe scripts/verify-real-media.py
"""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

import aiohttp
import aioice.ice
from aiortc import RTCConfiguration, RTCPeerConnection, RTCRtpSender, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame
import yaml

ROOT = Path(__file__).resolve().parents[1]


def unused_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


class MovingTestPattern(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.frame_number = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        frame = VideoFrame(width=320, height=240, format='yuv420p')
        frame.planes[0].update(bytes([24 + self.frame_number % 160]) * frame.planes[0].buffer_size)
        for plane in frame.planes[1:]:
            plane.update(bytes([128]) * plane.buffer_size)
        frame.pts, frame.time_base = pts, time_base
        self.frame_number += 1
        return frame


def h264_only(transceiver):
    codecs = [c for c in RTCRtpSender.getCapabilities('video').codecs if c.mimeType.lower() == 'video/h264']
    assert codecs, 'H264 codec unavailable in test runtime'
    transceiver.setCodecPreferences(codecs)


async def exchange(client, peer, url, headers):
    await peer.setLocalDescription(await peer.createOffer())
    async with client.post(url, data=peer.localDescription.sdp, headers={**headers, 'Content-Type': 'application/sdp'}) as response:
        sdp = await response.text()
        assert response.status == 201, f'{url.rsplit("/", 1)[-1]} status={response.status}: {sdp[:300]}'
        location = response.headers['Location']
        assert location.startswith('/media/inspection/'), 'session URL escaped same-origin proxy'
    assert 'H264/90000' in sdp, 'Media server did not negotiate H264'
    await peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type='answer'))
    return location


async def run_check(private_dir, app_port, media_port):
    # aioice 默认排除环回候选。测试显式限定真实 UDP socket 绑定环回接口，
    # 不向用户的其他网卡开放测试流；不替换 ICE/DTLS/SRTP 或媒体实现。
    aioice.ice.get_host_addresses = lambda use_ipv4, use_ipv6: ['127.0.0.1']
    access_file = private_dir / 'access.local.json'
    for _ in range(200):
        if access_file.exists():
            break
        await asyncio.sleep(0.05)
    assert access_file.exists(), 'application did not become ready'
    access = json.loads(access_file.read_text())
    origin = access['origin']
    publisher = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    viewer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    publisher.addTrack(MovingTestPattern())
    h264_only(publisher.getTransceivers()[0])
    h264_only(viewer.addTransceiver('video', direction='recvonly'))
    frames = []
    done = asyncio.Event()
    receive_task = None

    @viewer.on('track')
    def on_track(track):
        nonlocal receive_task

        async def receive():
            for _ in range(90):
                frame = await track.recv()
                frames.append({'pts': frame.pts, 'width': frame.width, 'height': frame.height, 'luma': bytes(frame.planes[0])[0]})
            done.set()

        receive_task = asyncio.create_task(receive())

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as client:
            for _ in range(100):
                try:
                    async with client.options(f'http://127.0.0.1:{media_port}/inspection/whep'):
                        break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.1)
            async with client.post(origin + '/media/inspection/whip', data='v=0') as response:
                assert response.status == 401, 'unauthorized publishing accepted'
            async with client.post(origin + '/media/inspection/whep', data='v=0') as response:
                assert response.status == 401, 'unauthorized viewing accepted'
            async with client.post(origin + '/api/session', json={'password': access['password']}, headers={'Origin': origin}) as response:
                assert response.status == 200
                login = await response.json()
                cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            viewer_headers = {'Origin': origin, 'Cookie': cookie, 'X-CSRF-Token': login['csrf_token']}
            publisher_headers = {'Authorization': 'Bearer ' + access['deviceToken']}
            publish_path = await exchange(client, publisher, origin + '/media/inspection/whip', publisher_headers)
            async with client.post(f'http://127.0.0.1:{media_port}/inspection/whip', data=publisher.localDescription.sdp, headers={'Content-Type': 'application/sdp', 'Authorization': 'Bearer ' + access['deviceToken']}) as response:
                internal_denied_status = response.status
                rejection = await response.text()
                # v1.15.6 把上游鉴权 403 包装为 WHEP/WHIP JSON 400。
                assert response.status == 400 and 'authentication failed' in rejection and 'code 403' in rejection, f'internal media wrong credential status={response.status}: {rejection[:200]}'
            for _ in range(100):
                if publisher.connectionState == 'connected':
                    break
                await asyncio.sleep(0.05)
            assert publisher.connectionState == 'connected', 'publisher ICE/DTLS did not connect'
            # ICE connected 不等于已经有 H264 RTP。等待真实媒体包到达后再发 WHEP。
            published_packets = 0
            for _ in range(100):
                stats = await publisher.getStats()
                published_packets = sum(s.packetsSent for s in stats.values() if s.type == 'outbound-rtp')
                if published_packets >= 20:
                    break
                await asyncio.sleep(0.1)
            assert published_packets >= 20, f'connected but H264 RTP not sent: {published_packets} packets'
            await asyncio.sleep(0.5)
            viewer_path = await exchange(client, viewer, origin + '/media/inspection/whep', viewer_headers)
            await asyncio.wait_for(done.wait(), timeout=20)
            assert len(frames) == 90 and len({f['luma'] for f in frames}) > 20, 'received frozen or incomplete stream'
            assert all(f['width'] == 320 and f['height'] == 240 for f in frames)
            assert all(frames[i]['pts'] < frames[i + 1]['pts'] for i in range(len(frames) - 1)), 'frame timestamps failed to advance'
            streaming_states = {'publisher': publisher.connectionState, 'viewer': viewer.connectionState}
            assert streaming_states == {'publisher': 'connected', 'viewer': 'connected'}
            browser_tested = '--browser' in sys.argv
            if browser_tested:
                process_options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
                browser_test = await asyncio.create_subprocess_exec('node', str(ROOT / 'scripts/verify-browser-media.mjs'), str(private_dir), cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, **process_options)
                try:
                    output, _ = await asyncio.wait_for(browser_test.communicate(), 90)
                except asyncio.TimeoutError:
                    browser_test.kill()
                    await browser_test.wait()
                    raise AssertionError('browser media test timed out')
                (ROOT / 'artifacts/browser-media-run.log').write_bytes(output)
                assert browser_test.returncode == 0, output.decode('utf-8', errors='replace')[-3000:]
            async with client.delete(origin + '/api/session', headers=viewer_headers) as response:
                assert response.status == 200
            for _ in range(40):
                if viewer.connectionState == 'closed':
                    break
                await asyncio.sleep(0.05)
            assert viewer.connectionState == 'closed', 'logout left an established media session running'
            async with client.delete(origin + viewer_path, headers=viewer_headers) as response:
                assert response.status == 401, 'logout did not revoke viewer access'
            async with client.delete(origin + publish_path, headers=publisher_headers) as response:
                assert response.status == 200 or response.status == 204
            return {'passed': True, 'source': 'synthetic_local_media', 'codec': 'H264', 'decoded_frames': len(frames), 'dimensions': [320, 240], 'distinct_decoded_luma': len({f['luma'] for f in frames}), 'connection_states_during_stream': streaming_states, 'viewer_closed_on_logout': True, 'unauthenticated_publish_status': 401, 'unauthenticated_read_status': 401, 'internal_media_rejects_device_token_status': internal_denied_status, 'logged_out_read_status': 401, 'same_origin_locations': True, 'public_network_tested': False, 'camera_hardware_tested': False, 'browser_tested': browser_tested}
    finally:
        if receive_task and not receive_task.done():
            receive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await receive_task
        await viewer.close()
        await publisher.close()


def main():
    media_exe = Path(os.environ.get('MEDIAMTX_BIN', ROOT / 'tooling/media/mediamtx-1.15.6/mediamtx.exe'))
    assert media_exe.is_file(), 'Install checksum-verified MediaMTX 1.15.6 or set MEDIAMTX_BIN'
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    result_file = artifacts / 'real-media-result.json'
    result_file.write_text(json.dumps({'passed': False, 'status': 'running', 'started_at_utc': datetime.now(timezone.utc).isoformat()}) + '\n', encoding='utf-8')
    app_port, media_port, ice_port = unused_port(), unused_port(), unused_port()
    process_options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    with tempfile.TemporaryDirectory(prefix='inspection-media-') as directory:
        private = Path(directory)
        config = yaml.safe_load((ROOT / 'deploy/mediamtx.yml').read_text(encoding='utf-8'))
        config.update({'logLevel': 'info', 'authHTTPAddress': f'http://127.0.0.1:{app_port}/internal/media-auth', 'webrtcAddress': f'127.0.0.1:{media_port}', 'webrtcLocalUDPAddress': f'127.0.0.1:{ice_port}', 'webrtcLocalTCPAddress': f'127.0.0.1:{ice_port}', 'webrtcAdditionalHosts': ['127.0.0.1']})
        config_file = private / 'mediamtx.yml'
        config_file.write_text(yaml.safe_dump(config), encoding='utf-8')
        with (artifacts / 'media-process.log').open('w', encoding='utf-8') as media_log, (artifacts / 'media-app.log').open('w', encoding='utf-8') as app_log:
            application = subprocess.Popen(['node', str(ROOT / 'scripts/media-test-server.js'), str(private), str(app_port), str(media_port)], cwd=ROOT, stdout=app_log, stderr=subprocess.STDOUT, **process_options)
            media = subprocess.Popen([str(media_exe), str(config_file)], cwd=ROOT, stdout=media_log, stderr=subprocess.STDOUT, **process_options)
            started = time.monotonic()
            try:
                result = asyncio.run(run_check(private, app_port, media_port))
                result.update({'measured_at_utc': datetime.now(timezone.utc).isoformat(), 'elapsed_seconds': round(time.monotonic() - started, 3), 'mediamtx_version': '1.15.6', 'mediamtx_exe_sha256': hashlib.sha256(media_exe.read_bytes()).hexdigest()})
                result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                print(json.dumps(result, ensure_ascii=False, indent=2))
            except Exception as error:
                result_file.write_text(json.dumps({'passed': False, 'status': 'failed', 'error': str(error), 'measured_at_utc': datetime.now(timezone.utc).isoformat()}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                raise
            finally:
                for process in [media, application]:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)


if __name__ == '__main__':
    main()
