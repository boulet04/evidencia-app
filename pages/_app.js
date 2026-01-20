// pages/_app.js
import Head from "next/head";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        {/* Charge le design system partagé */}
        <link rel="stylesheet" href="/brand.css" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <style jsx global>{`
        html,
        body {
          margin: 0 !important;
          padding: 0 !important;
          background: #05060a !important;
          overflow-x: hidden;
        }

        /* évite les micro-bords dus à certains éléments */
        * {
          box-sizing: border-box;
        }
      `}</style>

      <Component {...pageProps} />
    </>
  );
}
