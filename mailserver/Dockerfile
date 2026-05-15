FROM alpine:3.19

# Install postfix and curl
RUN apk add --no-cache postfix curl bash

# Configure postfix to receive all mail for multiple domains
RUN postconf -e "myhostname=mail.trustysquire.ai" && \
    postconf -e "mydestination=trustysquire.ai,speakeasyapp.xyz,vouchflow.dev,helmpoint.ai" && \
    postconf -e "inet_interfaces=all" && \
    postconf -e "mynetworks=0.0.0.0/0" && \
    postconf -e "mailbox_command=/usr/local/bin/forward-to-webhook"

# Create webhook forwarder script (forwards to API which handles aliases)
COPY forward-to-webhook.sh /usr/local/bin/forward-to-webhook
RUN chmod +x /usr/local/bin/forward-to-webhook

EXPOSE 25

CMD ["postfix", "start-fg"]
