import net from 'node:net'

/** Choose an OS-assigned loopback port, excluding known user services. */
export async function freePort (): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr === null || typeof addr === 'string') { server.close(); reject(new Error('Cannot obtain free port')); return }
        server.close(error => { if (error !== undefined) reject(error); else resolve(addr.port) })
      })
    })
    if (![5180, 5181, 5190].includes(port)) return port
  }
}
