import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLanPairingUrl,
  canonicalAllowedLanPath,
  discoverPrivateLanAddresses,
  isAllowedLanPath,
  LanGateway,
  isPrivateIpv4,
  isSameIpv4Subnet,
} from '../lan.js'

test('LAN discovery prefers physical RFC1918 adapters and excludes overlay ranges', () => {
  const interfaces = {
    Tailscale: [{ family: 'IPv4', address: '100.92.130.87', internal: false, cidr: '100.92.130.87/32' }],
    FlClash: [{ family: 'IPv4', address: '198.18.0.0', internal: false, cidr: '198.18.0.0/30' }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.64.1', internal: false, cidr: '172.28.64.1/20' }],
    Ethernet: [{ family: 'IPv4', address: '10.20.30.40', internal: false, cidr: '10.20.30.40/24' }],
    WLAN: [{ family: 'IPv4', address: '192.168.10.2', internal: false, cidr: '192.168.10.2/24' }],
  }
  const addresses = discoverPrivateLanAddresses(interfaces)
  assert.deepEqual(addresses.map((item) => item.address), ['192.168.10.2', '10.20.30.40'])
  assert.equal(addresses[0].interfaceName, 'WLAN')
})

test('automatic binding fails closed when multiple physical LANs are active', () => {
  const gateway = new LanGateway({
    interfaces: () => ({
      WLAN: [{ family: 'IPv4', address: '192.168.10.2', internal: false, cidr: '192.168.10.2/24' }],
      Ethernet: [{ family: 'IPv4', address: '10.20.30.40', internal: false, cidr: '10.20.30.40/24' }],
    }),
  })
  const state = gateway.inspect()
  assert.equal(state.ready, false)
  assert.equal(state.code, 'lan/ambiguous-address')
  assert.match(state.message, /configure lanHost explicitly/)
})

test('LAN URL builder allows private HTTP only and never returns loopback', () => {
  assert.equal(isPrivateIpv4('192.168.10.2'), true)
  assert.equal(isPrivateIpv4('10.0.0.8'), true)
  assert.equal(isPrivateIpv4('172.31.255.254'), true)
  assert.equal(isPrivateIpv4('172.32.0.1'), false)
  assert.equal(isPrivateIpv4('100.92.130.87'), false)
  assert.equal(
    buildLanPairingUrl('http://192.168.10.2:57890', '/remote#p=token'),
    'http://192.168.10.2:57890/remote#p=token',
  )
  assert.throws(() => buildLanPairingUrl('http://127.0.0.1:57890', '/remote#p=token'), /private IPv4/)
  assert.throws(() => buildLanPairingUrl('http://8.8.8.8:57890', '/remote#p=token'), /private IPv4/)
})

test('LAN peers must be inside the selected adapter subnet', () => {
  assert.equal(isSameIpv4Subnet('192.168.10.88', '192.168.10.2', 24), true)
  assert.equal(isSameIpv4Subnet('::ffff:192.168.10.88', '192.168.10.2', 24), true)
  assert.equal(isSameIpv4Subnet('192.168.11.88', '192.168.10.2', 24), false)
  assert.equal(isSameIpv4Subnet('10.0.0.8', '192.168.10.2', 24), false)
})

test('LAN ingress allowlist excludes DSH root and operator API', () => {
  for (const pathname of [
    '/remote', '/remote/app.js', '/remote/app.css',
    '/remote-control/exchange', '/remote-control/device-api',
  ]) assert.equal(isAllowedLanPath(pathname), true, pathname)

  for (const pathname of ['/', '/api/remote-control/status', '/settings', '/remote/extra']) {
    assert.equal(isAllowedLanPath(pathname), false, pathname)
  }
  assert.equal(canonicalAllowedLanPath('/remote'), '/remote')
  for (const alias of [
    '/api/../remote', '/x/%2e%2e/remote', '/api\\..\\remote',
    'http://host/api/../remote', '//host/remote', '/remote?cache=1',
  ]) assert.equal(canonicalAllowedLanPath(alias), null, alias)
})
