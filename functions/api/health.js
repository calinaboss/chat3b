export async function onRequest(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    status: 'ok',
    school: 'Irigem',
    class: '3B',
    db_connected: Boolean(env.DATABASE_URL)
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
