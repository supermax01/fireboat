# Only the owner-approved, locally cached Node index. The builder checks its
# linux/arm64 child and every config/layer blob before using it.
FROM node@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
ENV NODE_ENV=production
WORKDIR /opt/fireboat
# A minimal context assembled from the verified offline production installation.
# No checkout source, npm cache, helper installation, credentials or build step.
COPY --chown=0:0 runtime/ /opt/fireboat/
RUN ln -s /opt/fireboat/node_modules/@fireboat/gateway/dist/packages/server/src/cli.js /usr/local/bin/fireboat
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/fireboat"]
CMD []
