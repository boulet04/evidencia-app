// pages/_app.js
import Head from "next/head";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <link rel="stylesheet" href="/brand.css" />
        <meta name="theme-color" content="#050608" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
