export default function App({ Component, pageProps }) {
  return (
    <>
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
