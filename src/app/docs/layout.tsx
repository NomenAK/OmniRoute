import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import type { ReactNode } from "react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

const docsLayoutOptions: BaseLayoutProps = {
  nav: {
    title: "OmniRoute Docs",
    url: "/docs",
  },
  links: [
    {
      text: "Docs Home",
      url: "/docs",
    },
    {
      text: "\u2190 Back to Dashboard",
      url: "/dashboard",
      secondary: true,
    },
  ],
  githubUrl: "https://github.com/diegosouzapw/OmniRoute",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{
        defaultTheme: "dark",
        attribute: "class",
      }}
      search={{
        options: {
          api: "/docs/api/search",
        },
      }}
    >
      <DocsLayout tree={source.pageTree} {...docsLayoutOptions}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
