import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface TrickleFrontendCertificateStackProps extends cdk.StackProps {
  stage: string;
  hostedZoneName: string;
}

/**
 * Stack for CloudFront certificate (must be in us-east-1)
 * CloudFront requires certificates to be in us-east-1 regardless of where
 * the main stack is deployed.
 */
export class TrickleFrontendCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: TrickleFrontendCertificateStackProps) {
    super(scope, id, {
      ...props,
      env: {
        ...props.env,
        region: "us-east-1", // CloudFront certificates MUST be in us-east-1
      },
    });

    const { stage } = props;
    const isProduction = stage === "production";
    const frontendDomain = isProduction ? "trickle.qed.fi" : `${stage}.trickle.qed.fi`;

    // Look up the existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    // Create certificate in us-east-1 for CloudFront
    this.certificate = new acm.Certificate(this, "FrontendCertificate", {
      domainName: frontendDomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    this.certificateArn = this.certificate.certificateArn;

    // Export certificate ARN for cross-stack reference
    new cdk.CfnOutput(this, "CertificateArn", {
      value: this.certificateArn,
      description: "Frontend certificate ARN (us-east-1)",
      exportName: `trickle-${stage}-frontend-certificate-arn`,
    });
  }
}
